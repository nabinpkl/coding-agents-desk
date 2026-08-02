use super::*;

pub(super) struct CreatedLease {
    pub(super) session: Session,
    pub(super) descriptor: OwnedFd,
}

pub(super) fn create_session(
    state: &Arc<Mutex<VaultState>>,
    max_sessions: usize,
    request: CreateSession,
) -> Result<CreatedLease> {
    validate_session_name(&request.name)?;
    let columns = validate_dimension("columns", request.columns)?;
    let rows = validate_dimension("rows", request.rows)?;
    let (cwd, shell, mut command) = launch_command(
        request
            .launch
            .ok_or_else(|| TerminalError::Protocol("vault launch is required".to_owned()))?,
    )?;
    let mut locked = state.lock().map_err(lock_error)?;
    if locked.sessions.contains_key(&request.name) {
        return Err(TerminalError::Protocol(format!(
            "vault session already exists: {}",
            request.name
        )));
    }
    if locked.sessions.len() >= max_sessions {
        return Err(TerminalError::Protocol(
            "vault session limit reached".to_owned(),
        ));
    }
    let generation = locked.next_generation;
    locked.next_generation = locked.next_generation.wrapping_add(1).max(1);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::Pty(error.to_string()))?;
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "agentdesk");
    command.env("PTY_SESSION", &request.name);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| TerminalError::Pty(error.to_string()))?;
    let pid = child
        .process_id()
        .ok_or_else(|| TerminalError::Pty("vault child pid unavailable".to_owned()))?;
    let process_group = pair
        .master
        .process_group_leader()
        .ok_or_else(|| TerminalError::Pty("vault process group unavailable".to_owned()))?;
    let master_raw = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| TerminalError::Pty("vault master descriptor unavailable".to_owned()))?;
    let primary = duplicate_descriptor(master_raw)?;
    let lease = duplicate_descriptor(master_raw)?;
    let metadata = Session {
        name: request.name.clone(),
        cwd,
        shell,
        pid,
        process_group,
        generation,
        started_at_unix_milliseconds: unix_time_milliseconds(),
        columns: u32::from(columns),
        rows: u32::from(rows),
        exited: false,
        exit_status: 0,
    };
    locked.sessions.insert(
        request.name.clone(),
        VaultSession {
            metadata: metadata.clone(),
            master: primary,
        },
    );
    drop(locked);
    drop(child);
    drop(pair);
    spawn_exit_observer(state.clone(), request.name, generation, pid);
    Ok(CreatedLease {
        session: metadata,
        descriptor: lease,
    })
}

pub(super) fn launch_command(
    launch: create_session::Launch,
) -> Result<(String, String, CommandBuilder)> {
    match launch {
        create_session::Launch::ShellLaunch(launch) => {
            let mut command = CommandBuilder::new_default_prog();
            command.env("SHELL", &launch.shell);
            Ok((launch.cwd, launch.shell, command))
        }
        create_session::Launch::CommandLaunch(launch) => {
            if launch.executable.is_empty() {
                return Err(TerminalError::Protocol(
                    "command executable must not be empty".to_owned(),
                ));
            }
            let mut command = CommandBuilder::new(&launch.executable);
            command.args(launch.arguments);
            Ok((launch.cwd, launch.executable, command))
        }
    }
}

pub(super) fn spawn_exit_observer(
    state: Arc<Mutex<VaultState>>,
    session_name: String,
    generation: u64,
    pid: u32,
) {
    thread::spawn(move || {
        let status = match crate::process_observer::observe_exit_status(pid) {
            Ok(status) => status,
            Err(error) => {
                tracing::warn!(%error, pid, session = %session_name, "vault exit observer failed");
                -1
            }
        };
        // Reap while this vault is still the spawning parent. After a vault
        // handover this returns ECHILD, while kqueue still supplies the exact
        // exit status.
        let mut wait_status = 0;
        unsafe {
            libc::waitpid(pid as libc::pid_t, &mut wait_status, libc::WNOHANG);
        }
        let Ok(mut state) = state.lock() else {
            return;
        };
        let Some(session) = state.sessions.get_mut(&session_name) else {
            return;
        };
        if session.metadata.generation != generation {
            return;
        }
        session.metadata.exited = true;
        session.metadata.exit_status = status;
    });
}

pub(super) fn matching_session<'a>(
    state: &'a VaultState,
    name: &str,
    generation: u64,
) -> Result<&'a VaultSession> {
    let session = state
        .sessions
        .get(name)
        .ok_or_else(|| TerminalError::SessionNotFound(name.to_owned()))?;
    if session.metadata.generation != generation {
        return Err(TerminalError::Protocol(format!(
            "stale vault session generation for {name}"
        )));
    }
    Ok(session)
}

pub(super) fn matching_session_mut<'a>(
    state: &'a mut VaultState,
    name: &str,
    generation: u64,
) -> Result<&'a mut VaultSession> {
    let session = state
        .sessions
        .get_mut(name)
        .ok_or_else(|| TerminalError::SessionNotFound(name.to_owned()))?;
    if session.metadata.generation != generation {
        return Err(TerminalError::Protocol(format!(
            "stale vault session generation for {name}"
        )));
    }
    Ok(session)
}

pub(super) fn validate_dimension(label: &str, value: u32) -> Result<u16> {
    if value < 2 || value > u16::MAX as u32 {
        return Err(TerminalError::Protocol(format!(
            "{label} must be between 2 and {}",
            u16::MAX
        )));
    }
    Ok(value as u16)
}

pub(super) fn resize_descriptor(descriptor: RawFd, columns: u16, rows: u16) -> Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(descriptor, libc::TIOCSWINSZ, &size) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(super) fn validate_process_group(session: &VaultSession) -> Result<()> {
    let child = session.metadata.pid as libc::pid_t;
    let current_group = unsafe { libc::getpgid(child) };
    let foreground_group = unsafe { libc::tcgetpgrp(session.master.as_raw_fd()) };
    if current_group <= 0
        || current_group != session.metadata.process_group
        || foreground_group <= 0
        || foreground_group != session.metadata.process_group
    {
        return Err(TerminalError::Protocol(format!(
            "vault process identity changed for {}",
            session.metadata.name
        )));
    }
    Ok(())
}

pub(super) fn signal_process_group(process_group: i32, signal: i32) -> Result<()> {
    if process_group <= 0 || unsafe { libc::kill(-process_group, signal) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
