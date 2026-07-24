use std::fs;
use std::future::Future;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{error, info, warn};

use crate::error::{Result, TerminalError};
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
        let vault = VaultClient::new(
            options
                .base
                .socket_path
                .with_file_name("pty-vault.sock"),
        );
        Self {
            options: options.base,
            state: Arc::new(Mutex::new(PtyManagerState::new(options.limits, vault))),
            events_tx,
            events_rx,
            reaper,
            reap_rx,
            client_tasks: JoinSet::new(),
        }
    }

    pub async fn run(self) -> Result<()> {
        self.run_until_shutdown(wait_for_shutdown_signal()).await
    }

    pub async fn run_until_shutdown<F>(mut self, shutdown: F) -> Result<()>
    where
        F: Future<Output = ()>,
    {
        prepare_socket(&self.options.socket_path)?;
        let listener = UnixListener::bind(&self.options.socket_path)?;
        info!(socket = %self.options.socket_path.display(), "pty manager listening");
        tokio::pin!(shutdown);

        let mut resync_tick = tokio::time::interval(std::time::Duration::from_millis(50));
        let run_result = loop {
            tokio::select! {
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => self.spawn_client(stream),
                        Err(error) => break Err(error.into()),
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
        run_result
    }

    fn spawn_client(&mut self, stream: UnixStream) {
        let state = self.state.clone();
        let events = self.events_tx.clone();
        let reaper = self.reaper.clone();
        self.client_tasks.spawn(async move {
            if let Err(error) = handle_client(stream, state, events, reaper).await {
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
