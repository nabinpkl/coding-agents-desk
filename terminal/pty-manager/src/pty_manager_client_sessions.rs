use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::error::{Result, TerminalError};
use crate::protocol::{
    self, create_or_attach, validate_session_name, Attached, ClientDetached, ClientSummary,
    CreateOrAttach, Envelope, Payload, SessionLifetime, SessionSnapshot,
};
use crate::pty_session::{PtyEvent, PtyLaunch, PtySession};
use crate::session_registry::SessionRegistry;

pub(crate) struct PtyManagerState {
    pub(crate) registry: SessionRegistry,
    pub(crate) sessions: HashMap<String, LiveSession>,
    pub(crate) client_sessions: HashMap<u64, HashSet<String>>,
    pub(crate) observers: HashMap<u64, mpsc::UnboundedSender<Envelope>>,
    pending_reaps: HashMap<String, PendingReap>,
    next_session_generation: u64,
    next_reap_token: u64,
}

pub(crate) struct LiveSession {
    pub(crate) pty: PtySession,
    pub(crate) lifetime: SessionLifetime,
    pub(crate) generation: u64,
    pub(crate) clients: HashMap<u64, LiveClient>,
}

pub(crate) struct ReapRequest {
    pub(crate) session_name: String,
    pub(crate) session_generation: u64,
    pub(crate) token: u64,
}

#[derive(Clone)]
pub(crate) struct ReapScheduler {
    grace: Duration,
    tx: mpsc::UnboundedSender<ReapRequest>,
}

struct PendingReap {
    session_generation: u64,
    token: u64,
    task: JoinHandle<()>,
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
            pending_reaps: HashMap::new(),
            next_session_generation: 1,
            next_reap_token: 1,
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

    fn allocate_session_generation(&mut self) -> u64 {
        let generation = self.next_session_generation;
        self.next_session_generation = self.next_session_generation.wrapping_add(1).max(1);
        generation
    }

    fn cancel_pending_reap(&mut self, session_name: &str) {
        if let Some(pending) = self.pending_reaps.remove(session_name) {
            pending.task.abort();
        }
    }

    fn schedule_reap(&mut self, session_name: &str, scheduler: &ReapScheduler) {
        let Some((lifetime, has_clients, session_generation)) =
            self.sessions.get(session_name).map(|session| {
                (
                    session.lifetime,
                    !session.clients.is_empty(),
                    session.generation,
                )
            })
        else {
            return;
        };
        if lifetime != SessionLifetime::Leased
            || has_clients
            || self.pending_reaps.contains_key(session_name)
        {
            return;
        }

        let token = self.next_reap_token;
        self.next_reap_token = self.next_reap_token.wrapping_add(1).max(1);
        let request = ReapRequest {
            session_name: session_name.to_owned(),
            session_generation,
            token,
        };
        let tx = scheduler.tx.clone();
        let grace = scheduler.grace;
        let task = tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let _ = tx.send(request);
        });
        self.pending_reaps.insert(
            session_name.to_owned(),
            PendingReap {
                session_generation,
                token,
                task,
            },
        );
    }

    fn remove_session_state(&mut self, session_name: &str) -> Option<LiveSession> {
        self.cancel_pending_reap(session_name);
        let session = self.sessions.remove(session_name)?;
        let _ = self.registry.remove(session_name);
        for sessions in self.client_sessions.values_mut() {
            sessions.remove(session_name);
        }
        self.client_sessions
            .retain(|_, sessions| !sessions.is_empty());
        Some(session)
    }
}

impl ReapScheduler {
    pub(crate) fn new(grace: Duration, tx: mpsc::UnboundedSender<ReapRequest>) -> Self {
        Self { grace, tx }
    }
}

pub(crate) async fn create_or_attach(
    state: &Arc<Mutex<PtyManagerState>>,
    events: &mpsc::UnboundedSender<PtyEvent>,
    request_id: u64,
    client_id: u64,
    client_tx: &mpsc::UnboundedSender<Envelope>,
    close_tx: &mpsc::UnboundedSender<()>,
    session_name: &str,
    request: CreateOrAttach,
) -> Result<()> {
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
        state.cancel_pending_reap(session_name);
    } else {
        if !request.create_if_missing {
            return Err(TerminalError::SessionNotFound(session_name.to_owned()));
        }
        let launch = match request.launch.as_ref().expect("launch checked above") {
            create_or_attach::Launch::ShellLaunch(launch) => PtyLaunch::Shell {
                cwd: defaulted_cwd(&launch.cwd),
                shell: defaulted_shell(&launch.shell),
            },
            create_or_attach::Launch::CommandLaunch(launch) => {
                if launch.executable.is_empty() {
                    return Err(TerminalError::Protocol(
                        "command executable must not be empty".to_owned(),
                    ));
                }
                PtyLaunch::Command {
                    cwd: defaulted_cwd(&launch.cwd),
                    executable: launch.executable.clone(),
                    arguments: launch.arguments.clone(),
                }
            }
        };
        let generation = state.allocate_session_generation();
        let pty = PtySession::spawn(
            session_name,
            generation,
            launch,
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
            unix_time_milliseconds(),
        )?;
        state.sessions.insert(
            session_name.to_owned(),
            LiveSession {
                pty,
                lifetime,
                generation,
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
    let _ = client_tx.send(protocol::envelope(
        request_id,
        session_name,
        Payload::Attached(attached),
    ));

    Ok(())
}

fn unix_time_milliseconds() -> u64 {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(milliseconds).unwrap_or(u64::MAX)
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
            .remove_session_state(session_name)
            .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
        session.pty.kill()?;
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

pub(crate) async fn detach_client(
    state: &Arc<Mutex<PtyManagerState>>,
    reaper: &ReapScheduler,
    client_id: u64,
) -> bool {
    let mut state = state.lock().await;
    let Some(session_names) = state.client_sessions.remove(&client_id) else {
        return false;
    };
    let mut detached = false;
    let mut final_leases = Vec::new();
    for session_name in session_names {
        if let Some(session) = state.sessions.get_mut(&session_name) {
            session.clients.remove(&client_id);
            detached = true;
            if session.lifetime == SessionLifetime::Leased && session.clients.is_empty() {
                final_leases.push(session_name);
            }
        }
    }
    for session_name in final_leases {
        state.schedule_reap(&session_name, reaper);
    }
    detached
}

pub(crate) async fn close_client(
    state: &Arc<Mutex<PtyManagerState>>,
    reaper: &ReapScheduler,
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
        let final_lease = session.lifetime == SessionLifetime::Leased && session.clients.is_empty();
        let remaining_sessions = state.client_sessions.entry(client_id).or_default();
        remaining_sessions.remove(session_name);
        let close_connection = remaining_sessions.is_empty();
        if close_connection {
            state.client_sessions.remove(&client_id);
        }
        if final_lease {
            state.schedule_reap(session_name, reaper);
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

pub(crate) async fn reap_session(
    state: &Arc<Mutex<PtyManagerState>>,
    request: ReapRequest,
) -> bool {
    let removed = {
        let mut state = state.lock().await;
        let pending_matches = state
            .pending_reaps
            .get(&request.session_name)
            .map(|pending| {
                pending.session_generation == request.session_generation
                    && pending.token == request.token
            })
            .unwrap_or(false);
        let session_matches = state
            .sessions
            .get(&request.session_name)
            .map(|session| {
                session.generation == request.session_generation
                    && session.lifetime == SessionLifetime::Leased
                    && session.clients.is_empty()
            })
            .unwrap_or(false);
        if !pending_matches || !session_matches {
            return false;
        }
        state.remove_session_state(&request.session_name)
    };

    let Some(mut session) = removed else {
        return false;
    };
    let _ = session.pty.kill();
    let _ = session.pty.wait_status();
    notify_removed_clients(
        &request.session_name,
        129,
        session.clients.into_iter(),
        false,
    );
    true
}

pub(crate) async fn handle_natural_exit(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    generation: u64,
    fallback_status: i32,
) -> bool {
    let removed = {
        let mut state = state.lock().await;
        if state
            .sessions
            .get(session_name)
            .map(|session| session.generation)
            != Some(generation)
        {
            return false;
        }
        state.remove_session_state(session_name)
    };
    let Some(mut session) = removed else {
        return false;
    };
    let status = match session.pty.wait_status() {
        -1 => fallback_status,
        status => status,
    };
    let frame = protocol::envelope(
        0,
        session_name,
        Payload::SessionExited(protocol::SessionExited { status }),
    );
    for client in session.clients.into_values() {
        let _ = client.tx.send(frame.clone());
    }
    true
}

pub(crate) async fn shutdown_leased_sessions(state: &Arc<Mutex<PtyManagerState>>) -> bool {
    let removed = {
        let mut state = state.lock().await;
        let names = state
            .sessions
            .iter()
            .filter_map(|(name, session)| {
                (session.lifetime == SessionLifetime::Leased).then(|| name.clone())
            })
            .collect::<Vec<_>>();
        names
            .into_iter()
            .filter_map(|name| {
                state
                    .remove_session_state(&name)
                    .map(|session| (name, session))
            })
            .collect::<Vec<_>>()
    };
    let removed_any = !removed.is_empty();
    for (session_name, mut session) in removed {
        let _ = session.pty.kill();
        let _ = session.pty.wait_status();
        notify_removed_clients(&session_name, 129, session.clients.into_iter(), true);
    }
    removed_any
}

fn notify_removed_clients(
    session_name: &str,
    status: i32,
    clients: impl IntoIterator<Item = (u64, LiveClient)>,
    close_connection: bool,
) {
    let exited = protocol::envelope(
        0,
        session_name,
        Payload::SessionExited(protocol::SessionExited { status }),
    );
    for (client_id, client) in clients {
        let _ = client.tx.send(exited.clone());
        let _ = client.tx.send(protocol::envelope(
            0,
            session_name,
            Payload::ClientDetached(ClientDetached { client_id }),
        ));
        if close_connection {
            let _ = client.close_tx.send(());
        }
    }
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
