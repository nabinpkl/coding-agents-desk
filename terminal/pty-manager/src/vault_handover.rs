use super::*;
use crate::handover_common::{checksum, configure_stream, expect_phase, send_phase};
use crate::runtime_config::handover_timeout;

struct VaultSnapshot {
    sessions: Vec<Session>,
    descriptors: Vec<OwnedFd>,
    next_session_generation: u64,
    vault_generation: u64,
}

pub(super) fn perform_handover(runtime: &VaultRuntime, transfer_socket_path: &Path) -> Result<()> {
    let mut transfer = UnixStream::connect(transfer_socket_path)?;
    validate_peer(&transfer)?;
    configure_stream(&transfer)?;

    let snapshot = snapshot_state(&runtime.state)?;
    let checksum = session_checksum(
        snapshot.vault_generation + 1,
        snapshot.next_session_generation,
        &snapshot.sessions,
    );
    send_message(
        &mut transfer,
        &VaultHandoverManifest {
            protocol_version: VAULT_PROTOCOL_VERSION,
            vault_generation: snapshot.vault_generation + 1,
            next_session_generation: snapshot.next_session_generation,
            session_count: snapshot.sessions.len() as u32,
            checksum,
            sessions: snapshot.sessions.clone(),
        },
        Some(runtime.listener.as_raw_fd()),
    )?;
    for (index, (session, descriptor)) in snapshot
        .sessions
        .iter()
        .zip(&snapshot.descriptors)
        .enumerate()
    {
        send_message(
            &mut transfer,
            &VaultHandoverDescriptor {
                index: index as u32,
                session_name: session.name.clone(),
                session_generation: session.generation,
            },
            Some(descriptor.as_raw_fd()),
        )?;
    }
    expect_phase(&mut transfer, handover_phase::Phase::Ready, "vault")?;

    let commit_sessions = snapshot_metadata(&runtime.state)?;
    let commit_checksum = session_checksum(
        snapshot.vault_generation + 1,
        snapshot.next_session_generation,
        &commit_sessions,
    );
    send_message(
        &mut transfer,
        &VaultHandoverCommit {
            vault_generation: snapshot.vault_generation + 1,
            checksum: commit_checksum,
            sessions: commit_sessions,
        },
        None,
    )?;
    expect_phase(&mut transfer, handover_phase::Phase::Active, "vault")?;
    Ok(())
}

pub(super) fn receive_handover(options: &VaultOptions) -> Result<(Vault, UnixListener)> {
    if options.max_sessions == 0 {
        return Err(TerminalError::Protocol(
            "vault session limit must be positive".to_owned(),
        ));
    }
    let transfer_socket_path = candidate_socket_path(&options.socket_path);
    prepare_socket(&transfer_socket_path)?;
    let transfer_listener = UnixListener::bind(&transfer_socket_path)?;
    fs::set_permissions(&transfer_socket_path, fs::Permissions::from_mode(0o600))?;
    let cleanup = SocketCleanup(transfer_socket_path.clone());

    let request_id = unix_time_milliseconds().max(1);
    let mut control = UnixStream::connect(&options.socket_path)?;
    configure_stream(&control)?;
    send_message(
        &mut control,
        &VaultRequest {
            protocol_version: VAULT_PROTOCOL_VERSION,
            request_id,
            payload: Some(vault_request::Payload::BeginHandover(
                crate::vault_protocol::generated::BeginHandover {
                    transfer_socket_path: transfer_socket_path.to_string_lossy().into_owned(),
                },
            )),
        },
        None,
    )?;
    let mut transfer = accept_transfer_or_error(&transfer_listener, &mut control, request_id)?;
    configure_stream(&transfer)?;
    validate_peer(&transfer)?;

    let (manifest, listener_descriptor) = receive_message::<VaultHandoverManifest>(&mut transfer)?;
    validate_manifest(&manifest, options.max_sessions)?;
    let listener_descriptor = listener_descriptor.ok_or_else(|| {
        TerminalError::Protocol("vault handover omitted listener descriptor".to_owned())
    })?;
    let mut sessions = HashMap::with_capacity(manifest.sessions.len());
    for (expected_index, metadata) in manifest.sessions.iter().enumerate() {
        let (frame, descriptor) = receive_message::<VaultHandoverDescriptor>(&mut transfer)?;
        if frame.index != expected_index as u32
            || frame.session_name != metadata.name
            || frame.session_generation != metadata.generation
        {
            return Err(TerminalError::Protocol(
                "vault handover descriptor manifest mismatch".to_owned(),
            ));
        }
        let descriptor = descriptor.ok_or_else(|| {
            TerminalError::Protocol("vault handover omitted PTY descriptor".to_owned())
        })?;
        sessions.insert(
            metadata.name.clone(),
            VaultSession {
                metadata: metadata.clone(),
                master: descriptor,
            },
        );
    }

    let state = Arc::new(Mutex::new(VaultState {
        sessions,
        next_generation: manifest.next_session_generation,
        vault_generation: manifest.vault_generation,
    }));
    register_exit_observers(&state)?;
    send_phase(&mut transfer, handover_phase::Phase::Ready)?;
    let (commit, descriptor) = receive_message::<VaultHandoverCommit>(&mut transfer)?;
    if descriptor.is_some() {
        return Err(TerminalError::Protocol(
            "vault handover commit contained unexpected descriptor".to_owned(),
        ));
    }
    apply_handover_commit(&state, &manifest, commit)?;
    let listener = UnixListener::from(listener_descriptor);
    listener.set_nonblocking(true)?;
    send_phase(&mut transfer, handover_phase::Phase::Active)?;
    let (response, descriptor) = receive_message::<VaultResponse>(&mut control)?;
    if descriptor.is_some()
        || response.protocol_version != VAULT_PROTOCOL_VERSION
        || response.request_id != request_id
        || !response.error.is_empty()
        || !matches!(
            response.payload,
            Some(vault_response::Payload::Acknowledged(_))
        )
    {
        return Err(TerminalError::Protocol(format!(
            "vault handover activation was not acknowledged: {}",
            response.error
        )));
    }
    drop(cleanup);
    Ok((
        Vault {
            options: options.clone(),
            state,
        },
        listener,
    ))
}

fn snapshot_state(state: &Arc<Mutex<VaultState>>) -> Result<VaultSnapshot> {
    let state = state.lock().map_err(lock_error)?;
    let mut names = state.sessions.keys().cloned().collect::<Vec<_>>();
    names.sort();
    let mut sessions = Vec::with_capacity(names.len());
    let mut descriptors = Vec::with_capacity(names.len());
    for name in names {
        let session = state
            .sessions
            .get(&name)
            .ok_or_else(|| TerminalError::SessionNotFound(name.clone()))?;
        sessions.push(session.metadata.clone());
        descriptors.push(duplicate_descriptor(session.master.as_raw_fd())?);
    }
    Ok(VaultSnapshot {
        sessions,
        descriptors,
        next_session_generation: state.next_generation,
        vault_generation: state.vault_generation,
    })
}

fn snapshot_metadata(state: &Arc<Mutex<VaultState>>) -> Result<Vec<Session>> {
    let mut sessions = state
        .lock()
        .map_err(lock_error)?
        .sessions
        .values()
        .map(|session| session.metadata.clone())
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(sessions)
}

fn validate_manifest(manifest: &VaultHandoverManifest, max_sessions: usize) -> Result<()> {
    if manifest.protocol_version != VAULT_PROTOCOL_VERSION
        || manifest.vault_generation == 0
        || manifest.next_session_generation == 0
        || manifest.session_count as usize != manifest.sessions.len()
        || manifest.sessions.len() > max_sessions
    {
        return Err(TerminalError::Protocol(
            "invalid vault handover manifest".to_owned(),
        ));
    }
    let mut names = HashSet::with_capacity(manifest.sessions.len());
    for session in &manifest.sessions {
        validate_session_name(&session.name)?;
        if session.generation == 0 || !names.insert(session.name.clone()) {
            return Err(TerminalError::Protocol(
                "invalid vault handover session identity".to_owned(),
            ));
        }
    }
    if manifest.checksum
        != session_checksum(
            manifest.vault_generation,
            manifest.next_session_generation,
            &manifest.sessions,
        )
    {
        return Err(TerminalError::Protocol(
            "vault handover manifest checksum mismatch".to_owned(),
        ));
    }
    Ok(())
}

fn apply_handover_commit(
    state: &Arc<Mutex<VaultState>>,
    manifest: &VaultHandoverManifest,
    commit: VaultHandoverCommit,
) -> Result<()> {
    if commit.vault_generation != manifest.vault_generation
        || commit.sessions.len() != manifest.sessions.len()
        || commit.checksum
            != session_checksum(
                commit.vault_generation,
                manifest.next_session_generation,
                &commit.sessions,
            )
    {
        return Err(TerminalError::Protocol(
            "invalid vault handover commit".to_owned(),
        ));
    }
    let committed = commit
        .sessions
        .into_iter()
        .map(|session| (session.name.clone(), session))
        .collect::<HashMap<_, _>>();
    let mut state = state.lock().map_err(lock_error)?;
    for (name, session) in &mut state.sessions {
        let metadata = committed.get(name).ok_or_else(|| {
            TerminalError::Protocol("vault handover commit lost a session".to_owned())
        })?;
        if metadata.pid != session.metadata.pid
            || metadata.process_group != session.metadata.process_group
            || metadata.generation != session.metadata.generation
        {
            return Err(TerminalError::Protocol(
                "vault handover commit changed session identity".to_owned(),
            ));
        }
        session.metadata = metadata.clone();
    }
    Ok(())
}

fn register_exit_observers(state: &Arc<Mutex<VaultState>>) -> Result<()> {
    let sessions = state
        .lock()
        .map_err(lock_error)?
        .sessions
        .values()
        .filter(|session| !session.metadata.exited)
        .map(|session| {
            (
                session.metadata.name.clone(),
                session.metadata.generation,
                session.metadata.pid,
            )
        })
        .collect::<Vec<_>>();
    for (name, generation, pid) in sessions {
        spawn_exit_observer(state.clone(), name, generation, pid);
    }
    Ok(())
}

fn accept_transfer_or_error(
    listener: &UnixListener,
    control: &mut UnixStream,
    request_id: u64,
) -> Result<UnixStream> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + handover_timeout()?;
    while Instant::now() < deadline {
        let mut descriptors = [
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: control.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let ready = unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, 50) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if descriptors[1].revents & libc::POLLIN != 0 {
            let (response, descriptor) = receive_message::<VaultResponse>(control)?;
            if descriptor.is_some() || response.request_id != request_id {
                return Err(TerminalError::Protocol(
                    "invalid early vault handover response".to_owned(),
                ));
            }
            return Err(TerminalError::Protocol(if response.error.is_empty() {
                "vault rejected handover".to_owned()
            } else {
                response.error
            }));
        }
        if descriptors[0].revents & libc::POLLIN != 0 {
            return listener
                .accept()
                .map(|(stream, _)| stream)
                .map_err(Into::into);
        }
    }
    Err(TerminalError::Protocol(
        "timed out waiting for vault handover transfer".to_owned(),
    ))
}

fn session_checksum(
    vault_generation: u64,
    next_session_generation: u64,
    sessions: &[Session],
) -> u64 {
    checksum(
        vault_generation
            .to_be_bytes()
            .into_iter()
            .chain(next_session_generation.to_be_bytes())
            .chain(sessions.iter().flat_map(Message::encode_to_vec)),
    )
}

fn candidate_socket_path(stable_socket_path: &Path) -> PathBuf {
    let file_name = stable_socket_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pty-vault.sock");
    stable_socket_path.with_file_name(format!("{file_name}.candidate.{}", std::process::id()))
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
