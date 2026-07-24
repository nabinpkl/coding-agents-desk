use std::fs;
use std::future::Future;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{error, info, warn};

use crate::error::{Result, TerminalError};
use crate::manager_handover::{
    manager_handover_socket_path, receive_handover, send_handover, ManagerSnapshot,
};
use crate::protocol::{
    self, error_envelope, ClientDetached, CloseClient, Detach, Envelope, Input, KillSession,
    ListSessions, Output, Payload, RequestTerminalCheckpoint, SessionExited, SessionList,
    SubscribeSessions, TerminalViewerState,
};
use crate::pty_manager_client_sessions::{
    broadcast_session_snapshot, close_client, create_or_attach, detach_client, handle_natural_exit,
    kill_session, reap_session, remove_observer, request_checkpoint, retry_pending_client_state,
    send_input, subscribe_sessions, update_viewer_state, PtyManagerState, ReapRequest,
    ReapScheduler,
};
use crate::pty_session::PtyEvent;
use crate::vault_client::VaultClient;

pub use crate::pty_manager_client_sessions::PtyManagerLimits;

#[derive(Debug, Clone)]
pub struct PtyManagerOptions {
    pub socket_path: PathBuf,
    pub leased_session_grace: std::time::Duration,
}

impl PtyManagerOptions {
    pub fn with_limits(self, limits: PtyManagerLimits) -> PtyManagerConfiguredOptions {
        PtyManagerConfiguredOptions { base: self, limits }
    }
}

#[derive(Debug, Clone)]
pub struct PtyManagerConfiguredOptions {
    pub base: PtyManagerOptions,
    pub limits: PtyManagerLimits,
}

pub struct PtyManager {
    options: PtyManagerOptions,
    state: Arc<Mutex<PtyManagerState>>,
    events_tx: mpsc::Sender<PtyEvent>,
    events_rx: mpsc::Receiver<PtyEvent>,
    reaper: ReapScheduler,
    reap_rx: mpsc::Receiver<ReapRequest>,
    client_tasks: JoinSet<()>,
    handover_gate: Arc<RwLock<()>>,
    manager_generation: u64,
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

impl PtyManager {
    pub fn new(options: PtyManagerOptions) -> Self {
        Self::new_configured(options.with_limits(PtyManagerLimits::default()))
    }

    pub fn new_configured(options: PtyManagerConfiguredOptions) -> Self {
        let (events_tx, events_rx) = mpsc::channel(options.limits.pty_event_frames);
        let (reap_tx, reap_rx) = mpsc::channel(64);
        let reaper = ReapScheduler::new(options.base.leased_session_grace, reap_tx);
        let vault = VaultClient::new(options.base.socket_path.with_file_name("pty-vault.sock"));
        Self {
            options: options.base,
            state: Arc::new(Mutex::new(PtyManagerState::new(options.limits, vault))),
            events_tx,
            events_rx,
            reaper,
            reap_rx,
            client_tasks: JoinSet::new(),
            handover_gate: Arc::new(RwLock::new(())),
            manager_generation: 1,
        }
    }

    pub async fn run(self) -> Result<()> {
        self.run_with_ready(|| Ok(())).await
    }

    pub async fn run_with_ready<R>(self, ready: R) -> Result<()>
    where
        R: FnOnce() -> Result<()>,
    {
        self.run_until_shutdown_with_ready(wait_for_shutdown_signal(), ready)
            .await
    }

    pub async fn run_handover(self) -> Result<()> {
        self.run_handover_with_ready(|| Ok(())).await
    }

    pub async fn run_handover_with_ready<R>(mut self, ready: R) -> Result<()>
    where
        R: FnOnce() -> Result<()>,
    {
        let max_sessions = { self.state.lock().await.limits.max_sessions };
        let mut received = tokio::task::spawn_blocking({
            let socket_path = self.options.socket_path.clone();
            move || receive_handover(&socket_path, max_sessions)
        })
        .await
        .map_err(|error| TerminalError::Pty(format!("manager handover task failed: {error}")))??;
        self.manager_generation = received.manager_generation;
        let sessions = std::mem::take(&mut received.sessions);
        {
            let mut state = self.state.lock().await;
            for (session, descriptor) in sessions {
                state.restore_handover_session(session, descriptor, self.events_tx.clone())?;
            }
            state.prepare_session_io()?;
        }
        received.activate()?;
        self.state.lock().await.activate_session_io();
        let (public_listener, handover_listener) = received.into_listeners();
        let public_listener = UnixListener::from_std(public_listener)?;
        let handover_listener = UnixListener::from_std(handover_listener)?;
        self.run_with_listeners(
            public_listener,
            handover_listener,
            wait_for_shutdown_signal(),
            ready,
        )
        .await
    }

    pub async fn run_until_shutdown<F>(self, shutdown: F) -> Result<()>
    where
        F: Future<Output = ()>,
    {
        self.run_until_shutdown_with_ready(shutdown, || Ok(()))
            .await
    }

    async fn run_until_shutdown_with_ready<F, R>(self, shutdown: F, ready: R) -> Result<()>
    where
        F: Future<Output = ()>,
        R: FnOnce() -> Result<()>,
    {
        prepare_socket(&self.options.socket_path)?;
        let listener = UnixListener::bind(&self.options.socket_path)?;
        let handover_socket_path = manager_handover_socket_path(&self.options.socket_path);
        prepare_socket(&handover_socket_path)?;
        let handover_listener = UnixListener::bind(&handover_socket_path)?;
        fs::set_permissions(&handover_socket_path, fs::Permissions::from_mode(0o600))?;
        wait_for_vault(&self.options.socket_path).await?;
        {
            let mut state = self.state.lock().await;
            state.recover_vault_sessions(self.events_tx.clone())?;
            state.schedule_unattached_leases(&self.reaper);
        }
        self.run_with_listeners(listener, handover_listener, shutdown, ready)
            .await
    }

    async fn run_with_listeners<F, R>(
        mut self,
        listener: UnixListener,
        handover_listener: UnixListener,
        shutdown: F,
        ready: R,
    ) -> Result<()>
    where
        F: Future<Output = ()>,
        R: FnOnce() -> Result<()>,
    {
        ready()?;
        info!(socket = %self.options.socket_path.display(), "pty manager listening");
        tokio::pin!(shutdown);
        let mut handed_over = false;

        let mut resync_tick = tokio::time::interval(std::time::Duration::from_millis(50));
        let mut vault_tick = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut vault_custody_healthy = true;
        let run_result = loop {
            tokio::select! {
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => self.spawn_client(stream),
                        Err(error) => break Err(error.into()),
                    }
                }
                accepted = handover_listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let _handover_guard = self.handover_gate.clone().write_owned().await;
                            let result = self
                                .attempt_handover(stream, &listener, &handover_listener)
                                .await;
                            match result {
                                Ok(()) => {
                                    handed_over = true;
                                    break Ok(());
                                }
                                Err(error) => {
                                    warn!(%error, "manager candidate handover rolled back");
                                    self.state.lock().await.resume_session_io()?;
                                }
                            }
                        }
                        Err(error) => warn!(%error, "manager handover accept failed"),
                    }
                }
                Some(event) = self.events_rx.recv() => {
                    self.handle_pty_event(event).await;
                }
                Some(request) = self.reap_rx.recv() => {
                    if reap_session(&self.state, request).await {
                        broadcast_session_snapshot(&self.state).await;
                    }
                }
                _ = resync_tick.tick() => {
                    retry_pending_client_state(&self.state).await;
                }
                _ = vault_tick.tick() => {
                    let result = self.state.lock().await.ensure_vault_custody();
                    match (vault_custody_healthy, result) {
                        (true, Err(error)) => {
                            vault_custody_healthy = false;
                            warn!(%error, "PTY vault custody unavailable; manager leases retain sessions");
                        }
                        (false, Ok(())) => {
                            vault_custody_healthy = true;
                            info!("PTY vault custody restored from manager leases");
                        }
                        _ => {}
                    }
                }
                Some(result) = self.client_tasks.join_next(), if !self.client_tasks.is_empty() => {
                    if let Err(error) = result {
                        warn!(%error, "pty client task failed");
                    }
                }
                _ = &mut shutdown => break Ok(()),
            }
        };

        self.client_tasks.abort_all();
        while let Some(result) = self.client_tasks.join_next().await {
            if let Err(error) = result {
                if !error.is_cancelled() {
                    warn!(%error, "pty client task failed during shutdown");
                }
            }
        }
        if !handed_over {
            info!("pty manager stopped without handover; vault retains live sessions");
        }
        run_result
    }

    async fn attempt_handover(
        &mut self,
        stream: UnixStream,
        public_listener: &UnixListener,
        handover_listener: &UnixListener,
    ) -> Result<()> {
        let stream = stream.into_std()?;
        let pending_events = {
            let mut state = self.state.lock().await;
            state
                .sessions
                .values_mut()
                .flat_map(|session| session.pty.quiesce())
                .collect::<Vec<_>>()
        };
        while let Ok(event) = self.events_rx.try_recv() {
            self.handle_pty_event(event).await;
        }
        for event in pending_events {
            self.handle_pty_event(event).await;
        }
        let snapshot = {
            let mut state = self.state.lock().await;
            let snapshot = state.quiesce_and_snapshot()?;
            ManagerSnapshot {
                sessions: snapshot
                    .iter()
                    .map(|(session, _)| session.clone())
                    .collect(),
                descriptors: snapshot
                    .into_iter()
                    .map(|(_, descriptor)| descriptor)
                    .collect(),
            }
        };
        let public_descriptor = public_listener.as_raw_fd();
        let handover_descriptor = handover_listener.as_raw_fd();
        let generation = self.manager_generation;
        tokio::task::spawn_blocking(move || {
            send_handover(
                stream,
                public_descriptor,
                handover_descriptor,
                generation,
                snapshot,
            )
        })
        .await
        .map_err(|error| TerminalError::Pty(format!("manager handover task failed: {error}")))?
    }

    fn spawn_client(&mut self, stream: UnixStream) {
        let state = self.state.clone();
        let events = self.events_tx.clone();
        let reaper = self.reaper.clone();
        let handover_gate = self.handover_gate.clone();
        self.client_tasks.spawn(async move {
            if let Err(error) = handle_client(stream, state, events, reaper, handover_gate).await {
                warn!(%error, "client connection ended with error");
            }
        });
    }

    async fn handle_pty_event(&self, event: PtyEvent) {
        match event {
            PtyEvent::Output {
                session_name,
                generation,
                data,
            } => {
                let mut state = self.state.lock().await;
                let max_live_output_bytes = state.limits.client_live_outbox_bytes;
                let Some(session) = state
                    .sessions
                    .get_mut(&session_name)
                    .filter(|session| session.generation == generation)
                else {
                    return;
                };
                match session.headless.apply_output(&data) {
                    Ok(responses) => {
                        for response in responses {
                            if let Err(error) = session.pty.send_input(response) {
                                warn!(%error, session = %session_name, "terminal response queue failed");
                            }
                        }
                    }
                    Err(error) => {
                        error!(%error, session = %session_name, "headless terminal update failed");
                        return;
                    }
                }
                let revision = session.headless.revision();
                let byte_count = data.len();
                let frame = protocol::envelope(
                    0,
                    &session_name,
                    Payload::Output(Output { data, revision }),
                );
                for client in session.clients.values_mut() {
                    if client.needs_checkpoint {
                        continue;
                    }
                    let reserved = client.live_output_bytes.fetch_update(
                        Ordering::AcqRel,
                        Ordering::Acquire,
                        |current| {
                            current
                                .checked_add(byte_count)
                                .filter(|next| *next <= max_live_output_bytes)
                        },
                    );
                    if reserved.is_err() {
                        client.needs_checkpoint = true;
                        client
                            .minimum_live_revision
                            .store(revision, Ordering::Release);
                        continue;
                    }
                    if client.tx.try_send(frame.clone()).is_err() {
                        client
                            .live_output_bytes
                            .fetch_sub(byte_count, Ordering::AcqRel);
                        client.needs_checkpoint = true;
                        client
                            .minimum_live_revision
                            .store(revision, Ordering::Release);
                    }
                }
            }
            PtyEvent::Exited {
                session_name,
                generation,
                status,
            } => {
                if handle_natural_exit(&self.state, &session_name, generation, status).await {
                    broadcast_session_snapshot(&self.state).await;
                }
            }
        }
    }
}

async fn handle_client(
    stream: UnixStream,
    state: Arc<Mutex<PtyManagerState>>,
    events: mpsc::Sender<PtyEvent>,
    reaper: ReapScheduler,
    handover_gate: Arc<RwLock<()>>,
) -> Result<()> {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let framed = Framed::new(stream, LengthDelimitedCodec::new());
    let (mut socket_writer, mut socket_reader) = framed.split();
    let limits = { state.lock().await.limits.clone() };
    let (client_tx, mut client_rx) = mpsc::channel::<Envelope>(limits.client_outbox_frames);
    let live_output_bytes = Arc::new(AtomicUsize::new(0));
    let minimum_live_revision = Arc::new(AtomicU64::new(0));
    let (close_tx, mut close_rx) = mpsc::channel::<()>(1);
    let writer_close_tx = close_tx.clone();

    let writer_live_output_bytes = live_output_bytes.clone();
    let writer_minimum_live_revision = minimum_live_revision.clone();
    let writer = AbortOnDrop(tokio::spawn(async move {
        while let Some(envelope) = client_rx.recv().await {
            let output = match envelope.payload.as_ref() {
                Some(Payload::Output(output)) => Some((output.revision, output.data.len())),
                _ => None,
            };
            if let Some((revision, byte_count)) = output {
                writer_live_output_bytes.fetch_sub(byte_count, Ordering::AcqRel);
                if revision <= writer_minimum_live_revision.load(Ordering::Acquire) {
                    continue;
                }
            }
            let close_after_send = matches!(
                envelope.payload.as_ref(),
                Some(Payload::ClientDetached(detached)) if detached.client_id == client_id
            );
            let bytes = match protocol::encode(&envelope) {
                Ok(bytes) => bytes,
                Err(error) => {
                    error!(%error, "failed to encode envelope");
                    break;
                }
            };
            if socket_writer.send(bytes).await.is_err() {
                break;
            }
            if close_after_send {
                let _ = writer_close_tx.try_send(());
                break;
            }
        }
    }));

    loop {
        let frame = tokio::select! {
            frame = socket_reader.next() => frame,
            _ = close_rx.recv() => break,
        };
        let Some(frame) = frame else {
            break;
        };
        let envelope = protocol::decode(&frame?)?;
        let _handover_guard = handover_gate.read().await;
        let request_id = envelope.request_id;
        let session_name = envelope.session_name.clone();
        match protocol::payload(envelope)? {
            Payload::CreateOrAttach(request) => {
                match create_or_attach(
                    &state,
                    &events,
                    request_id,
                    client_id,
                    &client_tx,
                    live_output_bytes.clone(),
                    minimum_live_revision.clone(),
                    &session_name,
                    request,
                )
                .await
                {
                    Ok(()) => broadcast_session_snapshot(&state).await,
                    Err(error) => {
                        let _ = client_tx.try_send(error_envelope(
                            request_id,
                            session_name,
                            error.to_string(),
                        ));
                    }
                }
            }
            Payload::Input(Input { data }) => {
                if data.len() > limits.max_input_bytes {
                    let _ = client_tx.try_send(error_envelope(
                        request_id,
                        session_name,
                        "input exceeds configured byte limit".to_owned(),
                    ));
                    continue;
                }
                if let Err(error) = send_input(&state, &session_name, client_id, data).await {
                    let _ = client_tx.try_send(error_envelope(
                        request_id,
                        session_name,
                        error.to_string(),
                    ));
                }
            }
            Payload::TerminalViewerState(viewer_state @ TerminalViewerState { .. }) => {
                if let Err(error) =
                    update_viewer_state(&state, &session_name, client_id, viewer_state).await
                {
                    let _ = client_tx.try_send(error_envelope(
                        request_id,
                        session_name,
                        error.to_string(),
                    ));
                }
            }
            Payload::RequestTerminalCheckpoint(RequestTerminalCheckpoint {
                last_applied_revision,
            }) => {
                if let Err(error) =
                    request_checkpoint(&state, &session_name, client_id, last_applied_revision)
                        .await
                {
                    let _ = client_tx.try_send(error_envelope(
                        request_id,
                        session_name,
                        error.to_string(),
                    ));
                }
            }
            Payload::Detach(Detach {}) => {
                match detach_client(&state, &reaper, client_id).await {
                    Ok(true) => broadcast_session_snapshot(&state).await,
                    Ok(false) => {}
                    Err(error) => {
                        let _ = client_tx.try_send(error_envelope(
                            request_id,
                            session_name,
                            error.to_string(),
                        ));
                    }
                }
                break;
            }
            Payload::ListSessions(ListSessions {}) => {
                let sessions = {
                    let state = state.lock().await;
                    state.session_summaries()
                };
                let _ = client_tx.try_send(protocol::envelope(
                    request_id,
                    "",
                    Payload::SessionList(SessionList { sessions }),
                ));
            }
            Payload::KillSession(KillSession {}) => {
                match kill_session(&state, &session_name).await {
                    Ok(status) => {
                        let _ = client_tx.try_send(protocol::envelope(
                            request_id,
                            session_name,
                            Payload::SessionExited(SessionExited { status }),
                        ));
                        broadcast_session_snapshot(&state).await;
                    }
                    Err(error) => {
                        let _ = client_tx.try_send(error_envelope(
                            request_id,
                            session_name,
                            error.to_string(),
                        ));
                    }
                }
            }
            Payload::CloseClient(CloseClient { client_id }) => {
                match close_client(&state, &reaper, &session_name, client_id).await {
                    Ok(()) => {
                        let _ = client_tx.try_send(protocol::envelope(
                            request_id,
                            session_name.clone(),
                            Payload::ClientDetached(ClientDetached { client_id }),
                        ));
                        broadcast_session_snapshot(&state).await;
                    }
                    Err(error) => {
                        let _ = client_tx.try_send(error_envelope(
                            request_id,
                            session_name,
                            error.to_string(),
                        ));
                    }
                }
            }
            Payload::SubscribeSessions(SubscribeSessions {}) => {
                subscribe_sessions(&state, client_id, &client_tx).await;
            }
            Payload::Hello(_)
            | Payload::Attached(_)
            | Payload::Output(_)
            | Payload::SessionList(_)
            | Payload::SessionSnapshot(_)
            | Payload::SessionExited(_)
            | Payload::ClientDetached(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_)
            | Payload::Error(_) => {
                let _ = client_tx.try_send(error_envelope(
                    request_id,
                    session_name,
                    "unexpected client payload".to_owned(),
                ));
            }
        }
    }

    let _handover_guard = handover_gate.read().await;
    let detached = match detach_client(&state, &reaper, client_id).await {
        Ok(detached) => detached,
        Err(error) => {
            warn!(client_id, %error, "failed to release terminal viewport during disconnect");
            false
        }
    };
    remove_observer(&state, client_id).await;
    if detached {
        broadcast_session_snapshot(&state).await;
    }
    writer.0.abort();
    Ok(())
}

struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    signal = tokio::signal::ctrl_c() => {
                        if let Err(error) = signal {
                            warn!(%error, "ctrl-c signal handler failed");
                        }
                    }
                    _ = terminate.recv() => {}
                }
            }
            Err(error) => {
                warn!(%error, "SIGTERM signal handler failed");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn wait_for_vault(manager_socket_path: &Path) -> Result<()> {
    let client = VaultClient::new(manager_socket_path.with_file_name("pty-vault.sock"));
    let mut last_error = None;
    for _ in 0..200 {
        match client.list() {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Err(last_error
        .unwrap_or_else(|| TerminalError::Protocol("PTY vault did not become ready".to_owned())))
}

pub fn prepare_socket(path: &Path) -> Result<()> {
    if path.exists() {
        match StdUnixStream::connect(path) {
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
