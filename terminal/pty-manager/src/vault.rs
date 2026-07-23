use std::collections::HashMap;
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::error::{Result, TerminalError};
use crate::fd_transfer::{receive_message, send_message};
use crate::protocol::validate_session_name;
use crate::vault_protocol::generated::{
    create_session, vault_request, vault_response, Acknowledged, CreateSession, ExitStatus,
    Session, SessionLease, SessionList, VaultRequest, VaultResponse,
};
use crate::vault_protocol::VAULT_PROTOCOL_VERSION;

#[derive(Debug, Clone)]
pub struct VaultOptions {
    pub socket_path: PathBuf,
    pub max_sessions: usize,
}

pub struct Vault {
    options: VaultOptions,
    state: Arc<Mutex<VaultState>>,
}

struct VaultState {
    sessions: HashMap<String, VaultSession>,
    next_generation: u64,
}

struct VaultSession {
    metadata: Session,
    master: OwnedFd,
}

impl Vault {
    pub fn new(options: VaultOptions) -> Result<Self> {
        if options.max_sessions == 0 {
            return Err(TerminalError::Protocol(
                "vault session limit must be positive".to_owned(),
            ));
        }
        Ok(Self {
            options,
            state: Arc::new(Mutex::new(VaultState {
                sessions: HashMap::new(),
                next_generation: 1,
            })),
        })
    }

    pub fn run(self) -> Result<()> {
        self.run_until(Arc::new(AtomicBool::new(false)))
    }

    pub fn run_until(self, shutdown: Arc<AtomicBool>) -> Result<()> {
        prepare_socket(&self.options.socket_path)?;
        let listener = UnixListener::bind(&self.options.socket_path)?;
        fs::set_permissions(&self.options.socket_path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;

        while !shutdown.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let state = self.state.clone();
                    let max_sessions = self.options.max_sessions;
                    thread::spawn(move || {
                        if let Err(error) = handle_client(stream, state, max_sessions) {
                            tracing::warn!(%error, "pty vault client failed");
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

fn handle_client(
    mut stream: UnixStream,
    state: Arc<Mutex<VaultState>>,
    max_sessions: usize,
) -> Result<()> {
    validate_peer(&stream)?;
    let (request, descriptor) = receive_message::<VaultRequest>(&mut stream)?;
    if descriptor.is_some() {
        return Err(TerminalError::Protocol(
            "vault request contained unexpected descriptor".to_owned(),
        ));
    }
    let request_id = request.request_id;
    let result = if request.protocol_version != VAULT_PROTOCOL_VERSION {
        Err(TerminalError::Protocol(
            "vault protocol version mismatch".to_owned(),
        ))
    } else {
        handle_request(&state, max_sessions, request)
    };
    match result {
        Ok((payload, descriptor)) => {
            let raw_descriptor = descriptor.as_ref().map(AsRawFd::as_raw_fd);
            send_message(
                &mut stream,
                &VaultResponse {
                    protocol_version: VAULT_PROTOCOL_VERSION,
                    request_id,
                    error: String::new(),
                    payload: Some(payload),
                },
                raw_descriptor,
            )
        }
        Err(error) => send_message(
            &mut stream,
            &VaultResponse {
                protocol_version: VAULT_PROTOCOL_VERSION,
                request_id,
                error: error.to_string(),
                payload: None,
            },
            None,
        ),
    }
}

fn handle_request(
    state: &Arc<Mutex<VaultState>>,
    max_sessions: usize,
    request: VaultRequest,
) -> Result<(vault_response::Payload, Option<OwnedFd>)> {
    match request.payload.ok_or(TerminalError::MissingPayload)? {
        vault_request::Payload::CreateSession(request) => {
            let lease = create_session(state, max_sessions, request)?;
            let payload = vault_response::Payload::SessionLease(SessionLease {
                session: Some(lease.session),
            });
            Ok((payload, Some(lease.descriptor)))
        }
        vault_request::Payload::ListSessions(_) => {
            let sessions = state
                .lock()
                .map_err(lock_error)?
                .sessions
                .values()
                .map(|session| session.metadata.clone())
                .collect();
            Ok((
                vault_response::Payload::SessionList(SessionList { sessions }),
                None,
            ))
        }
        vault_request::Payload::LeaseSession(request) => {
            let state = state.lock().map_err(lock_error)?;
            let session = matching_session(&state, &request.name, request.generation)?;
            if session.metadata.exited {
                return Err(TerminalError::SessionExited(request.name));
            }
            let descriptor = duplicate_descriptor(session.master.as_raw_fd())?;
            let payload = vault_response::Payload::SessionLease(SessionLease {
                session: Some(session.metadata.clone()),
            });
            Ok((payload, Some(descriptor)))
        }
        vault_request::Payload::ResizeSession(request) => {
            let columns = validate_dimension("columns", request.columns)?;
            let rows = validate_dimension("rows", request.rows)?;
            let mut state = state.lock().map_err(lock_error)?;
            let session = matching_session_mut(&mut state, &request.name, request.generation)?;
            resize_descriptor(session.master.as_raw_fd(), columns, rows)?;
            session.metadata.columns = u32::from(columns);
            session.metadata.rows = u32::from(rows);
            Ok((vault_response::Payload::Acknowledged(Acknowledged {}), None))
        }
        vault_request::Payload::KillSession(request) => {
            let session = {
                let mut state = state.lock().map_err(lock_error)?;
                let session = matching_session(&state, &request.name, request.generation)?;
                validate_process_group(session)?;
                signal_process_group(session.metadata.process_group, libc::SIGHUP)?;
                state
                    .sessions
                    .remove(&request.name)
                    .ok_or_else(|| TerminalError::SessionNotFound(request.name.clone()))?
            };
            drop(session);
            Ok((
                vault_response::Payload::ExitStatus(ExitStatus {
                    exited: true,
                    status: 129,
                }),
                None,
            ))
        }
        vault_request::Payload::QueryExitStatus(request) => {
            let mut state = state.lock().map_err(lock_error)?;
            let session = matching_session(&state, &request.name, request.generation)?;
            let status = ExitStatus {
                exited: session.metadata.exited,
                status: session.metadata.exit_status,
            };
            if request.acknowledge && status.exited {
                state.sessions.remove(&request.name);
            }
            Ok((vault_response::Payload::ExitStatus(status), None))
        }
    }
}

struct CreatedLease {
    session: Session,
    descriptor: OwnedFd,
}

fn create_session(
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
        lifetime: request.lifetime,
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

fn launch_command(launch: create_session::Launch) -> Result<(String, String, CommandBuilder)> {
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

fn spawn_exit_observer(
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
        let mut wait_status = 0;
        unsafe {
            libc::waitpid(pid as libc::pid_t, &mut wait_status, libc::WNOHANG);
        }
    });
}

fn matching_session<'a>(
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

fn matching_session_mut<'a>(
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

fn validate_dimension(label: &str, value: u32) -> Result<u16> {
    if value < 2 || value > u16::MAX as u32 {
        return Err(TerminalError::Protocol(format!(
            "{label} must be between 2 and {}",
            u16::MAX
        )));
    }
    Ok(value as u16)
}

fn duplicate_descriptor(descriptor: RawFd) -> Result<OwnedFd> {
    let duplicate = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

fn resize_descriptor(descriptor: RawFd, columns: u16, rows: u16) -> Result<()> {
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

fn validate_process_group(session: &VaultSession) -> Result<()> {
    let current = unsafe { libc::tcgetpgrp(session.master.as_raw_fd()) };
    if current <= 0 || current != session.metadata.process_group {
        return Err(TerminalError::Protocol(format!(
            "vault process identity changed for {}",
            session.metadata.name
        )));
    }
    Ok(())
}

fn signal_process_group(process_group: i32, signal: i32) -> Result<()> {
    if process_group <= 0 || unsafe { libc::kill(-process_group, signal) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn validate_peer(stream: &UnixStream) -> Result<()> {
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if uid != unsafe { libc::geteuid() } {
        return Err(TerminalError::Protocol(
            "vault peer uid mismatch".to_owned(),
        ));
    }
    Ok(())
}

fn prepare_socket(path: &Path) -> Result<()> {
    if path.exists() {
        match UnixStream::connect(path) {
            Ok(_) => {
                return Err(TerminalError::ManagerAlreadyListening(
                    path.display().to_string(),
                ));
            }
            Err(_) => {
                let metadata = fs::metadata(path)?;
                if !metadata.file_type().is_socket() {
                    return Err(TerminalError::NonSocketPath(path.display().to_string()));
                }
                fs::remove_file(path)?;
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn unix_time_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> TerminalError {
    TerminalError::Pty("vault state lock poisoned".to_owned())
}
