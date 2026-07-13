use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};

use crate::error::{Result, TerminalError};
use crate::protocol::{
    self, create_or_attach, validate_session_name, Attached, ClientDetached, ClientSummary,
    CreateOrAttach, Envelope, Payload, SessionLifetime, SessionSnapshot,
};
use crate::pty_session::{PtyEvent, PtySession};
use crate::session_registry::SessionRegistry;

pub(crate) struct PtyManagerState {
    pub(crate) registry: SessionRegistry,
    pub(crate) sessions: HashMap<String, LiveSession>,
    pub(crate) client_sessions: HashMap<u64, HashSet<String>>,
    pub(crate) observers: HashMap<u64, mpsc::UnboundedSender<Envelope>>,
}

pub(crate) struct LiveSession {
    pub(crate) pty: PtySession,
    pub(crate) lifetime: SessionLifetime,
    pub(crate) clients: HashMap<u64, LiveClient>,
}

#[derive(Clone)]
pub(crate) struct LiveClient {
    pub(crate) title: String,
    pub(crate) tx: mpsc::UnboundedSender<Envelope>,
    pub(crate) close_tx: mpsc::UnboundedSender<()>,
}

impl PtyManagerState {
    pub(crate) fn new() -> Self {
        Self {
            registry: SessionRegistry::new(),
            sessions: HashMap::new(),
            client_sessions: HashMap::new(),
            observers: HashMap::new(),
        }
    }

    pub(crate) fn session_summaries(&self) -> Vec<protocol::SessionSummary> {
        let clients_by_session = self
            .sessions
            .iter()
            .map(|(session_name, session)| {
                let mut clients = session
                    .clients
                    .iter()
                    .map(|(client_id, client)| ClientSummary {
                        id: *client_id,
                        title: client.title.clone(),
                    })
                    .collect::<Vec<_>>();
                clients.sort_by_key(|client| client.id);
                (session_name.clone(), clients)
            })
            .collect::<BTreeMap<_, _>>();
        self.registry.list(&clients_by_session)
    }
}

pub(crate) async fn create_or_attach(
    state: &Arc<Mutex<PtyManagerState>>,
    events: &mpsc::UnboundedSender<PtyEvent>,
    client_id: u64,
    client_tx: &mpsc::UnboundedSender<Envelope>,
    close_tx: &mpsc::UnboundedSender<()>,
    session_name: &str,
    request: CreateOrAttach,
) -> Result<Attached> {
    validate_session_name(session_name)?;
    let lifetime = explicit_lifetime(request.lifetime)?;
    if request.launch.is_none() {
        return Err(TerminalError::Protocol(
            "create or attach requires an explicit launch".to_owned(),
        ));
    }

    let mut state = state.lock().await;
    if let Some(session) = state.sessions.get(session_name) {
        if session.lifetime != lifetime {
            return Err(TerminalError::Protocol(format!(
                "session lifetime mismatch for {session_name}: existing {:?}, requested {:?}",
                session.lifetime, lifetime
            )));
        }
    } else {
        if !request.create_if_missing {
            return Err(TerminalError::SessionNotFound(session_name.to_owned()));
        }
        let create_or_attach::Launch::ShellLaunch(launch) =
            request.launch.as_ref().expect("launch checked above")
        else {
            return Err(TerminalError::Protocol(
                "command launch creation is not implemented".to_owned(),
            ));
        };
        let cwd = defaulted_cwd(&launch.cwd);
        let shell = defaulted_shell(&launch.shell);
        let pty = PtySession::spawn(
            session_name,
            cwd,
            shell,
            request.columns.max(1).min(u16::MAX as u32) as u16,
            request.rows.max(1).min(u16::MAX as u32) as u16,
            events.clone(),
        )?;
        state.registry.ensure_running(
            session_name,
            pty.cwd.clone(),
            pty.shell.clone(),
            pty.pid,
            lifetime,
        )?;
        state.sessions.insert(
            session_name.to_owned(),
            LiveSession {
                pty,
                lifetime,
                clients: HashMap::new(),
            },
        );
    }

    let session = state
        .sessions
        .get_mut(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    let title = if request.client_title.is_empty() {
        format!("client {client_id}")
    } else {
        request.client_title
    };
    session.clients.insert(
        client_id,
        LiveClient {
            title,
            tx: client_tx.clone(),
            close_tx: close_tx.clone(),
        },
    );
    let attached = Attached {
        pid: session.pty.pid,
        cwd: session.pty.cwd.clone(),
        shell: session.pty.shell.clone(),
        client_count: session.clients.len() as u32,
        client_id,
    };

    state
        .client_sessions
        .entry(client_id)
        .or_default()
        .insert(session_name.to_owned());

    Ok(attached)
}

fn explicit_lifetime(value: i32) -> Result<SessionLifetime> {
    let lifetime = SessionLifetime::try_from(value)
        .map_err(|_| TerminalError::Protocol(format!("unknown session lifetime value {value}")))?;
    match lifetime {
        SessionLifetime::Persistent | SessionLifetime::Leased => Ok(lifetime),
        SessionLifetime::Unspecified => Err(TerminalError::Protocol(
            "create or attach requires an explicit session lifetime".to_owned(),
        )),
    }
}

fn defaulted_cwd(cwd: &str) -> PathBuf {
    if cwd.is_empty() || cwd == "~" {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(cwd)
    }
}

fn defaulted_shell(shell: &str) -> String {
    if shell.is_empty() {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
    } else {
        shell.to_owned()
    }
}

pub(crate) async fn send_input(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    data: Vec<u8>,
) -> Result<()> {
    let state = state.lock().await;
    let session = state
        .sessions
        .get(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    session.pty.send_input(data)
}

pub(crate) async fn resize_session(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    columns: u32,
    rows: u32,
) -> Result<()> {
    let state = state.lock().await;
    let session = state
        .sessions
        .get(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    session.pty.resize(
        columns.max(1).min(u16::MAX as u32) as u16,
        rows.max(1).min(u16::MAX as u32) as u16,
    )
}

pub(crate) async fn kill_session(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
) -> Result<i32> {
    let clients = {
        let mut state = state.lock().await;
        let mut session = state
            .sessions
            .remove(session_name)
            .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
        session.pty.kill()?;
        let _ = state.registry.remove(session_name);
        for sessions in state.client_sessions.values_mut() {
            sessions.remove(session_name);
        }
        state
            .client_sessions
            .retain(|_, sessions| !sessions.is_empty());
        session
            .clients
            .into_iter()
            .map(|(client_id, client)| {
                let close_connection = !state.client_sessions.contains_key(&client_id);
                (client_id, client, close_connection)
            })
            .collect::<Vec<_>>()
    };

    let frame = protocol::envelope(
        0,
        session_name,
        Payload::SessionExited(protocol::SessionExited { status: 129 }),
    );
    for (client_id, client, close_connection) in clients {
        let _ = client.tx.send(frame.clone());
        let _ = client.tx.send(protocol::envelope(
            0,
            session_name,
            Payload::ClientDetached(ClientDetached { client_id }),
        ));
        if close_connection {
            let _ = client.close_tx.send(());
        }
    }
    Ok(129)
}

pub(crate) async fn detach_client(state: &Arc<Mutex<PtyManagerState>>, client_id: u64) -> bool {
    let mut state = state.lock().await;
    let Some(session_names) = state.client_sessions.remove(&client_id) else {
        return false;
    };
    let mut detached = false;
    for session_name in session_names {
        if let Some(session) = state.sessions.get_mut(&session_name) {
            session.clients.remove(&client_id);
            detached = true;
        }
    }
    detached
}

pub(crate) async fn close_client(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    client_id: u64,
) -> Result<()> {
    let (client, close_connection) = {
        let mut state = state.lock().await;
        let session = state
            .sessions
            .get_mut(session_name)
            .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
        let client = session
            .clients
            .remove(&client_id)
            .ok_or(TerminalError::ClientNotFound(client_id))?;
        let remaining_sessions = state.client_sessions.entry(client_id).or_default();
        remaining_sessions.remove(session_name);
        let close_connection = remaining_sessions.is_empty();
        if close_connection {
            state.client_sessions.remove(&client_id);
        }
        (client, close_connection)
    };

    let _ = client.tx.send(protocol::envelope(
        0,
        session_name,
        Payload::ClientDetached(ClientDetached { client_id }),
    ));
    if close_connection {
        let _ = client.close_tx.send(());
    }
    Ok(())
}

pub(crate) async fn subscribe_sessions(
    state: &Arc<Mutex<PtyManagerState>>,
    client_id: u64,
    client_tx: &mpsc::UnboundedSender<Envelope>,
) {
    let snapshot = {
        let mut state = state.lock().await;
        state.observers.insert(client_id, client_tx.clone());
        state.session_summaries()
    };
    let _ = client_tx.send(protocol::envelope(
        0,
        "",
        Payload::SessionSnapshot(SessionSnapshot { sessions: snapshot }),
    ));
}

pub(crate) async fn remove_observer(state: &Arc<Mutex<PtyManagerState>>, client_id: u64) {
    let mut state = state.lock().await;
    state.observers.remove(&client_id);
}

pub(crate) async fn broadcast_session_snapshot(state: &Arc<Mutex<PtyManagerState>>) {
    let (snapshot, observers) = {
        let state = state.lock().await;
        (
            state.session_summaries(),
            state
                .observers
                .iter()
                .map(|(client_id, tx)| (*client_id, tx.clone()))
                .collect::<Vec<_>>(),
        )
    };
    if observers.is_empty() {
        return;
    }

    let frame = protocol::envelope(
        0,
        "",
        Payload::SessionSnapshot(SessionSnapshot { sessions: snapshot }),
    );
    let mut failed = Vec::new();
    for (client_id, observer) in observers {
        if observer.send(frame.clone()).is_err() {
            failed.push(client_id);
        }
    }

    if failed.is_empty() {
        return;
    }
    let mut state = state.lock().await;
    for client_id in failed {
        state.observers.remove(&client_id);
    }
}
