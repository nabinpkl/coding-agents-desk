use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use prost::Message;

use crate::error::{Result, TerminalError};
use crate::fd_transfer::{duplicate_descriptor, receive_message, send_message};
use crate::handover_common::validate_same_euid_peer;
use crate::protocol::validate_session_name;
use crate::vault_protocol::generated::{
    create_session, handover_phase, vault_request, vault_response, Acknowledged, CreateSession,
    ExitStatus, ImportSession, Session, SessionLease, SessionList, VaultHandoverCommit,
    VaultHandoverDescriptor, VaultHandoverManifest, VaultRequest, VaultResponse,
};
use crate::vault_protocol::{VAULT_PROTOCOL_VERSION, VAULT_PROTOCOL_VERSION_MIN};

#[path = "vault_handover.rs"]
mod handover;
#[path = "vault_sessions.rs"]
mod sessions;

use sessions::*;

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
    vault_generation: u64,
}

struct VaultSession {
    metadata: Session,
    master: OwnedFd,
}

struct VaultRuntime {
    state: Arc<Mutex<VaultState>>,
    listener: Arc<UnixListener>,
    shutdown: Arc<AtomicBool>,
    handover_in_progress: AtomicBool,
    authority: Mutex<()>,
    max_sessions: usize,
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
                vault_generation: 1,
            })),
        })
    }

    pub fn run(self) -> Result<()> {
        self.run_until(Arc::new(AtomicBool::new(false)))
    }

    pub fn run_with_ready<F>(self, ready: F) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        self.run_until_with_ready(Arc::new(AtomicBool::new(false)), ready)
    }

    pub fn run_until(self, shutdown: Arc<AtomicBool>) -> Result<()> {
        self.run_until_with_ready(shutdown, || Ok(()))
    }

    fn run_until_with_ready<F>(self, shutdown: Arc<AtomicBool>, ready: F) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        prepare_socket(&self.options.socket_path)?;
        let listener = UnixListener::bind(&self.options.socket_path)?;
        fs::set_permissions(&self.options.socket_path, fs::Permissions::from_mode(0o600))?;
        self.run_with_listener(listener, shutdown, ready)
    }

    pub fn handover(options: VaultOptions) -> Result<()> {
        Self::handover_until(options, Arc::new(AtomicBool::new(false)))
    }

    pub fn handover_with_ready<F>(options: VaultOptions, ready: F) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        let (vault, listener) = handover::receive_handover(&options)?;
        vault.run_with_listener(listener, Arc::new(AtomicBool::new(false)), ready)
    }

    pub fn handover_until(options: VaultOptions, shutdown: Arc<AtomicBool>) -> Result<()> {
        let (vault, listener) = handover::receive_handover(&options)?;
        vault.run_with_listener(listener, shutdown, || Ok(()))
    }

    fn run_with_listener<F>(
        self,
        listener: UnixListener,
        shutdown: Arc<AtomicBool>,
        ready: F,
    ) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        listener.set_nonblocking(true)?;
        let runtime = Arc::new(VaultRuntime {
            state: self.state,
            listener: Arc::new(listener),
            shutdown: shutdown.clone(),
            handover_in_progress: AtomicBool::new(false),
            authority: Mutex::new(()),
            max_sessions: self.options.max_sessions,
        });
        ready()?;
        {
            let state = runtime.state.lock().map_err(lock_error)?;
            tracing::info!(
                socket = %self.options.socket_path.display(),
                sessions = state.sessions.len(),
                generation = state.vault_generation,
                "pty vault ready"
            );
        }

        while !shutdown.load(Ordering::Acquire) {
            match runtime.listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false)?;
                    let runtime = runtime.clone();
                    thread::spawn(move || {
                        if let Err(error) = handle_client(stream, runtime) {
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

fn handle_client(mut stream: UnixStream, runtime: Arc<VaultRuntime>) -> Result<()> {
    validate_peer(&stream)?;
    let (request, descriptor) = receive_message::<VaultRequest>(&mut stream)?;
    let request_id = request.request_id;
    // Answer in the dialect we were addressed in, so a manager from another commit reading our
    // reply sees the version it sent rather than a mismatch it cannot act on.
    let response_version = request.protocol_version;
    let result = if !(VAULT_PROTOCOL_VERSION_MIN..=VAULT_PROTOCOL_VERSION)
        .contains(&request.protocol_version)
    {
        Err(TerminalError::Protocol(format!(
            "vault protocol version {} is outside the supported range {}..={}",
            request.protocol_version, VAULT_PROTOCOL_VERSION_MIN, VAULT_PROTOCOL_VERSION
        )))
    } else {
        match request.payload {
            Some(vault_request::Payload::BeginHandover(request)) => {
                if descriptor.is_some() {
                    Err(TerminalError::Protocol(
                        "vault handover request contained a descriptor".to_owned(),
                    ))
                } else {
                    handle_handover(&runtime, request.transfer_socket_path)
                }
            }
            payload => {
                if runtime.handover_in_progress.load(Ordering::Acquire) {
                    Err(TerminalError::Protocol(
                        "vault handover in progress".to_owned(),
                    ))
                } else {
                    let _authority = runtime.authority.lock().map_err(lock_error)?;
                    if runtime.handover_in_progress.load(Ordering::Acquire) {
                        Err(TerminalError::Protocol(
                            "vault handover in progress".to_owned(),
                        ))
                    } else {
                        handle_request(
                            &runtime.state,
                            runtime.max_sessions,
                            VaultRequest { payload, ..request },
                            descriptor,
                        )
                    }
                }
            }
        }
    };
    match result {
        Ok((payload, descriptor)) => {
            let raw_descriptor = descriptor.as_ref().map(AsRawFd::as_raw_fd);
            send_message(
                &mut stream,
                &VaultResponse {
                    protocol_version: response_version,
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
                protocol_version: response_version,
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
    descriptor: Option<OwnedFd>,
) -> Result<(vault_response::Payload, Option<OwnedFd>)> {
    let payload = request.payload.ok_or(TerminalError::MissingPayload)?;
    if descriptor.is_some() && !matches!(&payload, vault_request::Payload::ImportSession(_)) {
        return Err(TerminalError::Protocol(
            "vault request contained unexpected descriptor".to_owned(),
        ));
    }
    match payload {
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
        vault_request::Payload::BeginHandover(_) => Err(TerminalError::Protocol(
            "nested vault handover request".to_owned(),
        )),
        vault_request::Payload::ImportSession(request) => {
            import_session(
                state,
                max_sessions,
                request,
                descriptor.ok_or_else(|| {
                    TerminalError::Protocol("vault import omitted PTY descriptor".to_owned())
                })?,
            )?;
            Ok((vault_response::Payload::Acknowledged(Acknowledged {}), None))
        }
    }
}

fn import_session(
    state: &Arc<Mutex<VaultState>>,
    max_sessions: usize,
    request: ImportSession,
    descriptor: OwnedFd,
) -> Result<()> {
    let metadata = request.session.ok_or_else(|| {
        TerminalError::Protocol("vault import omitted session metadata".to_owned())
    })?;
    validate_session_name(&metadata.name)?;
    if metadata.generation == 0 || metadata.pid == 0 || metadata.process_group <= 0 {
        return Err(TerminalError::Protocol(
            "vault import contained invalid process identity".to_owned(),
        ));
    }
    let imported = VaultSession {
        metadata: metadata.clone(),
        master: descriptor,
    };
    validate_process_group(&imported)?;
    let mut locked = state.lock().map_err(lock_error)?;
    if let Some(existing) = locked.sessions.get(&metadata.name) {
        if existing.metadata.generation == metadata.generation
            && existing.metadata.pid == metadata.pid
        {
            return Ok(());
        }
        return Err(TerminalError::Protocol(format!(
            "vault import conflicts with session {}",
            metadata.name
        )));
    }
    if locked.sessions.len() >= max_sessions {
        return Err(TerminalError::Protocol(
            "vault session limit reached".to_owned(),
        ));
    }
    locked.next_generation = locked
        .next_generation
        .max(metadata.generation.wrapping_add(1).max(1));
    locked.sessions.insert(metadata.name.clone(), imported);
    drop(locked);
    if !metadata.exited {
        spawn_exit_observer(
            state.clone(),
            metadata.name,
            metadata.generation,
            metadata.pid,
        );
    }
    Ok(())
}

fn handle_handover(
    runtime: &Arc<VaultRuntime>,
    transfer_socket_path: String,
) -> Result<(vault_response::Payload, Option<OwnedFd>)> {
    let _authority = runtime.authority.lock().map_err(lock_error)?;
    runtime
        .handover_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| TerminalError::Protocol("vault handover already in progress".to_owned()))?;
    let result = handover::perform_handover(runtime, Path::new(&transfer_socket_path));
    if result.is_err() {
        runtime.handover_in_progress.store(false, Ordering::Release);
    }
    result?;
    runtime.shutdown.store(true, Ordering::Release);
    Ok((vault_response::Payload::Acknowledged(Acknowledged {}), None))
}

fn validate_peer(stream: &UnixStream) -> Result<()> {
    validate_same_euid_peer(stream, "vault")
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
