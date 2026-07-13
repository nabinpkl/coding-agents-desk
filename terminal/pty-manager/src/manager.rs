use std::fs;
use std::future::Future;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
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
    ListSessions, Output, Payload, Resize, SessionExited, SessionList, SubscribeSessions,
};
use crate::pty_manager_client_sessions::{
    broadcast_session_snapshot, close_client, create_or_attach, detach_client, handle_natural_exit,
    kill_session, reap_session, remove_observer, resize_session, send_input,
    shutdown_leased_sessions, subscribe_sessions, PtyManagerState, ReapRequest, ReapScheduler,
};
use crate::pty_session::PtyEvent;

#[derive(Debug, Clone)]
pub struct PtyManagerOptions {
    pub socket_path: PathBuf,
    pub leased_session_grace: std::time::Duration,
}

pub struct PtyManager {
    options: PtyManagerOptions,
    state: Arc<Mutex<PtyManagerState>>,
    events_tx: mpsc::UnboundedSender<PtyEvent>,
    events_rx: mpsc::UnboundedReceiver<PtyEvent>,
    reaper: ReapScheduler,
    reap_rx: mpsc::UnboundedReceiver<ReapRequest>,
    client_tasks: JoinSet<()>,
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

impl PtyManager {
    pub fn new(options: PtyManagerOptions) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (reap_tx, reap_rx) = mpsc::unbounded_channel();
        let reaper = ReapScheduler::new(options.leased_session_grace, reap_tx);
        Self {
            options,
            state: Arc::new(Mutex::new(PtyManagerState::new())),
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
        if shutdown_leased_sessions(&self.state).await {
            broadcast_session_snapshot(&self.state).await;
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
                let clients = {
                    let state = self.state.lock().await;
                    state
                        .sessions
                        .get(&session_name)
                        .filter(|session| session.generation == generation)
                        .map(|session| {
                            session
                                .clients
                                .values()
                                .map(|client| client.tx.clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                };
                let frame = protocol::envelope(0, session_name, Payload::Output(Output { data }));
                for client in clients {
                    let _ = client.send(frame.clone());
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
    events: mpsc::UnboundedSender<PtyEvent>,
    reaper: ReapScheduler,
) -> Result<()> {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let framed = Framed::new(stream, LengthDelimitedCodec::new());
    let (mut socket_writer, mut socket_reader) = framed.split();
    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<Envelope>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    let writer = AbortOnDrop(tokio::spawn(async move {
        while let Some(envelope) = client_rx.recv().await {
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
                    &close_tx,
                    &session_name,
                    request,
                )
                .await
                {
                    Ok(()) => broadcast_session_snapshot(&state).await,
                    Err(error) => {
                        let _ = client_tx.send(error_envelope(
                            request_id,
                            session_name,
                            error.to_string(),
                        ));
                    }
                }
            }
            Payload::Input(Input { data }) => {
                if let Err(error) = send_input(&state, &session_name, data).await {
                    let _ =
                        client_tx.send(error_envelope(request_id, session_name, error.to_string()));
                }
            }
            Payload::Resize(Resize { columns, rows }) => {
                if let Err(error) = resize_session(&state, &session_name, columns, rows).await {
                    let _ =
                        client_tx.send(error_envelope(request_id, session_name, error.to_string()));
                }
            }
            Payload::Detach(Detach {}) => {
                if detach_client(&state, &reaper, client_id).await {
                    broadcast_session_snapshot(&state).await;
                }
                break;
            }
            Payload::ListSessions(ListSessions {}) => {
                let sessions = {
                    let state = state.lock().await;
                    state.session_summaries()
                };
                let _ = client_tx.send(protocol::envelope(
                    request_id,
                    "",
                    Payload::SessionList(SessionList { sessions }),
                ));
            }
            Payload::KillSession(KillSession {}) => {
                match kill_session(&state, &session_name).await {
                    Ok(status) => {
                        let _ = client_tx.send(protocol::envelope(
                            request_id,
                            session_name,
                            Payload::SessionExited(SessionExited { status }),
                        ));
                        broadcast_session_snapshot(&state).await;
                    }
                    Err(error) => {
                        let _ = client_tx.send(error_envelope(
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
                        let _ = client_tx.send(protocol::envelope(
                            request_id,
                            session_name.clone(),
                            Payload::ClientDetached(ClientDetached { client_id }),
                        ));
                        broadcast_session_snapshot(&state).await;
                    }
                    Err(error) => {
                        let _ = client_tx.send(error_envelope(
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
            | Payload::Error(_) => {
                let _ = client_tx.send(error_envelope(
                    request_id,
                    session_name,
                    "unexpected client payload".to_owned(),
                ));
            }
        }
    }

    let detached = detach_client(&state, &reaper, client_id).await;
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
