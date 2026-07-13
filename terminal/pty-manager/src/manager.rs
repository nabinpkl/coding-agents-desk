use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{error, info, warn};

use crate::error::{Result, TerminalError};
use crate::protocol::{
    self, error_envelope, ClientDetached, CloseClient, Detach, Envelope, Input, KillSession,
    ListSessions, Output, Payload, Resize, SessionExited, SessionList, SubscribeSessions,
};
use crate::pty_manager_client_sessions::{
    broadcast_session_snapshot, close_client, create_or_attach, detach_client, kill_session,
    remove_observer, resize_session, send_input, subscribe_sessions, PtyManagerState,
};
use crate::pty_session::PtyEvent;

#[derive(Debug, Clone)]
pub struct PtyManagerOptions {
    pub socket_path: PathBuf,
}

pub struct PtyManager {
    options: PtyManagerOptions,
    state: Arc<Mutex<PtyManagerState>>,
    events_tx: mpsc::UnboundedSender<PtyEvent>,
    events_rx: mpsc::UnboundedReceiver<PtyEvent>,
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

impl PtyManager {
    pub fn new(options: PtyManagerOptions) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            options,
            state: Arc::new(Mutex::new(PtyManagerState::new())),
            events_tx,
            events_rx,
        }
    }

    pub async fn run(mut self) -> Result<()> {
        prepare_socket(&self.options.socket_path)?;
        let listener = UnixListener::bind(&self.options.socket_path)?;
        info!(socket = %self.options.socket_path.display(), "pty manager listening");

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted?;
                    self.spawn_client(stream);
                }
                Some(event) = self.events_rx.recv() => {
                    self.handle_pty_event(event).await;
                }
                signal = tokio::signal::ctrl_c() => {
                    if let Err(error) = signal {
                        warn!(%error, "ctrl-c signal handler failed");
                    }
                    break;
                }
            }
        }

        Ok(())
    }

    fn spawn_client(&self, stream: UnixStream) {
        let state = self.state.clone();
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_client(stream, state, events).await {
                warn!(%error, "client connection ended with error");
            }
        });
    }

    async fn handle_pty_event(&self, event: PtyEvent) {
        match event {
            PtyEvent::Output { session_name, data } => {
                let clients = {
                    let state = self.state.lock().await;
                    state
                        .sessions
                        .get(&session_name)
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
                status,
            } => {
                let (clients, wait_status) = {
                    let mut state = self.state.lock().await;
                    let wait_status = state
                        .sessions
                        .get_mut(&session_name)
                        .map(|session| session.pty.wait_status())
                        .unwrap_or(status);
                    let clients = state
                        .sessions
                        .remove(&session_name)
                        .map(|session| {
                            session
                                .clients
                                .into_values()
                                .map(|client| client.tx)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let _ = state.registry.mark_exited(&session_name);
                    for sessions in state.client_sessions.values_mut() {
                        sessions.remove(&session_name);
                    }
                    (clients, wait_status)
                };
                let frame = protocol::envelope(
                    0,
                    session_name,
                    Payload::SessionExited(SessionExited {
                        status: wait_status,
                    }),
                );
                for client in clients {
                    let _ = client.send(frame.clone());
                }
                broadcast_session_snapshot(&self.state).await;
            }
        }
    }
}

async fn handle_client(
    stream: UnixStream,
    state: Arc<Mutex<PtyManagerState>>,
    events: mpsc::UnboundedSender<PtyEvent>,
) -> Result<()> {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let framed = Framed::new(stream, LengthDelimitedCodec::new());
    let (mut socket_writer, mut socket_reader) = framed.split();
    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<Envelope>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    let writer = tokio::spawn(async move {
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
    });

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
                if detach_client(&state, client_id).await {
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
                match close_client(&state, &session_name, client_id).await {
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

    let detached = detach_client(&state, client_id).await;
    remove_observer(&state, client_id).await;
    if detached {
        broadcast_session_snapshot(&state).await;
    }
    writer.abort();
    Ok(())
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
