use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::error::{Result, TerminalError};
use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{
    self, create_or_attach, validate_session_name, Attached, ClientDetached, ClientSummary,
    CreateOrAttach, Envelope, Payload, SessionLifetime, SessionSnapshot, TerminalCheckpointBegin,
    TerminalCheckpointChunk, TerminalCheckpointEnd, TerminalViewerState, TerminalViewportStatus,
};
use crate::pty_session::{PtyEvent, PtySession};
use crate::session_registry::SessionRegistry;
use crate::session_viewport::{SessionViewport, ViewportDecision};
use crate::vault_client::{VaultClient, VaultLaunch};

pub(crate) struct PtyManagerState {
    pub(crate) limits: PtyManagerLimits,
    pub(crate) registry: SessionRegistry,
    pub(crate) sessions: HashMap<String, LiveSession>,
    pub(crate) client_sessions: HashMap<u64, HashSet<String>>,
    pub(crate) observers: HashMap<u64, mpsc::Sender<Envelope>>,
    pending_reaps: HashMap<String, PendingReap>,
    next_reap_token: u64,
    vault: VaultClient,
}

pub(crate) struct LiveSession {
    pub(crate) pty: PtySession,
    pub(crate) headless: HeadlessTerminal,
    pub(crate) lifetime: SessionLifetime,
    pub(crate) generation: u64,
    pub(crate) clients: HashMap<u64, LiveClient>,
    viewport: SessionViewport,
    next_checkpoint_id: u64,
}

pub(crate) struct ReapRequest {
    pub(crate) session_name: String,
    pub(crate) session_generation: u64,
    pub(crate) token: u64,
}

#[derive(Clone)]
pub(crate) struct ReapScheduler {
    grace: Duration,
    tx: mpsc::Sender<ReapRequest>,
}

struct PendingReap {
    session_generation: u64,
    token: u64,
    task: JoinHandle<()>,
}

#[derive(Clone)]
pub(crate) struct LiveClient {
    pub(crate) title: String,
    pub(crate) tx: mpsc::Sender<Envelope>,
    pub(crate) needs_checkpoint: bool,
    pub(crate) live_output_bytes: Arc<AtomicUsize>,
    pub(crate) minimum_live_revision: Arc<AtomicU64>,
    needs_viewport_status: bool,
}

#[derive(Debug, Clone)]
pub struct PtyManagerLimits {
    pub max_sessions: usize,
    pub max_clients_per_session: usize,
    pub max_columns: u32,
    pub max_rows: u32,
    pub scrollback_lines: usize,
    pub max_checkpoint_bytes: usize,
    pub checkpoint_chunk_bytes: usize,
    pub client_outbox_frames: usize,
    pub client_live_outbox_bytes: usize,
    pub max_input_bytes: usize,
    pub pty_event_frames: usize,
}

impl Default for PtyManagerLimits {
    fn default() -> Self {
        Self {
            max_sessions: 64,
            max_clients_per_session: 16,
            max_columns: 512,
            max_rows: 256,
            scrollback_lines: 2_000,
            max_checkpoint_bytes: 16 * 1024 * 1024,
            checkpoint_chunk_bytes: 512 * 1024,
            client_outbox_frames: 256,
            client_live_outbox_bytes: 1024 * 1024,
            max_input_bytes: 64 * 1024,
            pty_event_frames: 512,
        }
    }
}

impl PtyManagerLimits {
    pub fn validate(&self) -> Result<()> {
        if self.max_sessions == 0
            || self.max_clients_per_session == 0
            || self.max_columns == 0
            || self.max_columns > u16::MAX as u32
            || self.max_rows == 0
            || self.max_rows > u16::MAX as u32
            || self.max_checkpoint_bytes == 0
            || self.checkpoint_chunk_bytes == 0
            || self.checkpoint_chunk_bytes > self.max_checkpoint_bytes
            || self.checkpoint_chunk_bytes > 3 * 1024 * 1024
            || self
                .max_checkpoint_bytes
                .div_ceil(self.checkpoint_chunk_bytes)
                > 256
            || self.client_outbox_frames < 4
            || self.client_live_outbox_bytes == 0
            || self.max_input_bytes == 0
            || self.pty_event_frames == 0
        {
            return Err(TerminalError::Protocol(
                "invalid PTY manager operational bounds".to_owned(),
            ));
        }
        Ok(())
    }
}

impl PtyManagerState {
    pub(crate) fn new(limits: PtyManagerLimits, vault: VaultClient) -> Self {
        Self {
            limits,
            registry: SessionRegistry::new(),
            sessions: HashMap::new(),
            client_sessions: HashMap::new(),
            observers: HashMap::new(),
            pending_reaps: HashMap::new(),
            next_reap_token: 1,
            vault,
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
                        active: session
                            .viewport
                            .viewer(*client_id)
                            .map(|viewer| viewer.active)
                            .unwrap_or(false),
                        columns: session
                            .viewport
                            .viewer(*client_id)
                            .map(|viewer| u32::from(viewer.columns))
                            .unwrap_or(0),
                        rows: session
                            .viewport
                            .viewer(*client_id)
                            .map(|viewer| u32::from(viewer.rows))
                            .unwrap_or(0),
                        is_owner: session.viewport.is_owner(*client_id),
                    })
                    .collect::<Vec<_>>();
                clients.sort_by_key(|client| client.id);
                (session_name.clone(), clients)
            })
            .collect::<BTreeMap<_, _>>();
        let runtime_by_session = self
            .sessions
            .iter()
            .map(|(session_name, session)| {
                let dimensions = session.headless.dimensions();
                (
                    session_name.clone(),
                    (
                        dimensions.columns as u32,
                        dimensions.rows as u32,
                        session.headless.revision(),
                        session.viewport.owner_client_id(),
                        session.viewport.ownership_epoch(),
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>();
        self.registry
            .list_with_runtime(&clients_by_session, &runtime_by_session)
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
            let _ = tx.send(request).await;
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
    pub(crate) fn new(grace: Duration, tx: mpsc::Sender<ReapRequest>) -> Self {
        Self { grace, tx }
    }
}

pub(crate) async fn create_or_attach(
    state: &Arc<Mutex<PtyManagerState>>,
    events: &mpsc::Sender<PtyEvent>,
    request_id: u64,
    client_id: u64,
    client_tx: &mpsc::Sender<Envelope>,
    live_output_bytes: Arc<AtomicUsize>,
    minimum_live_revision: Arc<AtomicU64>,
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
    let columns = validate_dimension("columns", request.columns, state.limits.max_columns)?;
    let rows = validate_dimension("rows", request.rows, state.limits.max_rows)?;
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
        if state.sessions.len() >= state.limits.max_sessions {
            return Err(TerminalError::Protocol("session limit reached".to_owned()));
        }
        let launch = match request.launch.as_ref().expect("launch checked above") {
            create_or_attach::Launch::ShellLaunch(launch) => VaultLaunch::Shell {
                cwd: defaulted_cwd(&launch.cwd).to_string_lossy().into_owned(),
                shell: defaulted_shell(&launch.shell),
            },
            create_or_attach::Launch::CommandLaunch(launch) => {
                if launch.executable.is_empty() {
                    return Err(TerminalError::Protocol(
                        "command executable must not be empty".to_owned(),
                    ));
                }
                VaultLaunch::Command {
                    cwd: defaulted_cwd(&launch.cwd).to_string_lossy().into_owned(),
                    executable: launch.executable.clone(),
                    arguments: launch.arguments.clone(),
                }
            }
        };
        let lease = state.vault.create(
            session_name,
            launch,
            columns,
            rows,
            lifetime as i32,
        )?;
        let started_at_unix_milliseconds = lease.session.started_at_unix_milliseconds;
        let generation = lease.session.generation;
        let pty = PtySession::from_vault_lease(lease, state.vault.clone(), events.clone())?;
        let headless = HeadlessTerminal::new(
            columns,
            rows,
            state.limits.scrollback_lines,
            state.limits.max_checkpoint_bytes,
        );
        state.registry.ensure_running(
            session_name,
            pty.cwd.clone(),
            pty.shell.clone(),
            pty.pid,
            lifetime,
            started_at_unix_milliseconds,
        )?;
        state.sessions.insert(
            session_name.to_owned(),
            LiveSession {
                pty,
                headless,
                lifetime,
                generation,
                clients: HashMap::new(),
                viewport: SessionViewport::default(),
                next_checkpoint_id: 1,
            },
        );
    }

    let max_clients_per_session = state.limits.max_clients_per_session;
    let checkpoint_chunk_bytes = state.limits.checkpoint_chunk_bytes;
    let session = state
        .sessions
        .get(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    if session.clients.len() >= max_clients_per_session {
        return Err(TerminalError::Protocol(
            "session client limit reached".to_owned(),
        ));
    }
    state
        .client_sessions
        .entry(client_id)
        .or_default()
        .insert(session_name.to_owned());
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
            needs_checkpoint: false,
            live_output_bytes,
            minimum_live_revision,
            needs_viewport_status: false,
        },
    );
    session.viewport.register(client_id, columns, rows);
    let dimensions = session.headless.dimensions();
    let attached = Attached {
        pid: session.pty.pid,
        cwd: session.pty.cwd.clone(),
        shell: session.pty.shell.clone(),
        client_count: session.clients.len() as u32,
        client_id,
        columns: dimensions.columns as u32,
        rows: dimensions.rows as u32,
        revision: session.headless.revision(),
        owner_client_id: session.viewport.owner_client_id(),
        ownership_epoch: session.viewport.ownership_epoch(),
    };

    let checkpoint = checkpoint_envelopes(session_name, session, checkpoint_chunk_bytes)?;

    client_tx
        .try_send(protocol::envelope(
            request_id,
            session_name,
            Payload::Attached(attached),
        ))
        .map_err(|_| {
            TerminalError::Protocol("client outbox unavailable during attach".to_owned())
        })?;
    for frame in checkpoint {
        client_tx.try_send(frame).map_err(|_| {
            TerminalError::Protocol("client outbox unavailable during checkpoint".to_owned())
        })?;
    }
    if let Some(client) = session.clients.get_mut(&client_id) {
        client.needs_viewport_status = true;
    }
    enqueue_pending_viewport_statuses(session_name, session);

    Ok(())
}

fn validate_dimension(name: &str, value: u32, maximum: u32) -> Result<u16> {
    if value == 0 || value > maximum {
        return Err(TerminalError::Protocol(format!(
            "{name} must be between 1 and {maximum}"
        )));
    }
    Ok(value as u16)
}

fn checkpoint_envelopes(
    session_name: &str,
    session: &mut LiveSession,
    chunk_bytes: usize,
) -> Result<Vec<Envelope>> {
    let checkpoint = session.headless.checkpoint()?;
    let checkpoint_id = session.next_checkpoint_id;
    session.next_checkpoint_id = session.next_checkpoint_id.checked_add(1).unwrap_or(1);
    let chunk_count = checkpoint.ansi.len().div_ceil(chunk_bytes);
    let chunk_count = u32::try_from(chunk_count)
        .map_err(|_| TerminalError::Protocol("checkpoint chunk count overflow".to_owned()))?;
    let mut frames = Vec::with_capacity(chunk_count as usize + 2);
    frames.push(protocol::envelope(
        0,
        session_name,
        Payload::TerminalCheckpointBegin(TerminalCheckpointBegin {
            checkpoint_id,
            revision: checkpoint.revision,
            columns: checkpoint.columns,
            rows: checkpoint.rows,
            total_bytes: checkpoint.ansi.len() as u64,
            chunk_count,
            history_truncated: checkpoint.history_truncated,
        }),
    ));
    for (index, data) in checkpoint.ansi.chunks(chunk_bytes).enumerate() {
        frames.push(protocol::envelope(
            0,
            session_name,
            Payload::TerminalCheckpointChunk(TerminalCheckpointChunk {
                checkpoint_id,
                index: index as u32,
                data: data.to_vec(),
            }),
        ));
    }
    frames.push(protocol::envelope(
        0,
        session_name,
        Payload::TerminalCheckpointEnd(TerminalCheckpointEnd {
            checkpoint_id,
            revision: checkpoint.revision,
        }),
    ));
    Ok(frames)
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
    client_id: u64,
    data: Vec<u8>,
) -> Result<()> {
    let mut state = state.lock().await;
    let chunk_bytes = state.limits.checkpoint_chunk_bytes;
    let session = state
        .sessions
        .get_mut(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    let decision = session.viewport.claim_for_input(client_id)?;
    apply_viewport_decision(session_name, session, decision, chunk_bytes)?;
    session.pty.send_input(data)
}

pub(crate) async fn update_viewer_state(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    client_id: u64,
    viewer_state: TerminalViewerState,
) -> Result<()> {
    let mut state = state.lock().await;
    let columns = validate_dimension("columns", viewer_state.columns, state.limits.max_columns)?;
    let rows = validate_dimension("rows", viewer_state.rows, state.limits.max_rows)?;
    let chunk_bytes = state.limits.checkpoint_chunk_bytes;
    let session = state
        .sessions
        .get_mut(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    let decision = session
        .viewport
        .update(client_id, viewer_state, columns, rows)?;
    if let Some(client) = session.clients.get_mut(&client_id) {
        client.needs_viewport_status = true;
    }
    apply_viewport_decision(session_name, session, decision, chunk_bytes)
}

fn apply_viewport_decision(
    session_name: &str,
    session: &mut LiveSession,
    decision: ViewportDecision,
    chunk_bytes: usize,
) -> Result<()> {
    let source_dimensions = session.headless.dimensions();
    let dimensions_changed = decision
        .requested_dimensions
        .map(|(columns, rows)| {
            source_dimensions.columns != usize::from(columns)
                || source_dimensions.rows != usize::from(rows)
        })
        .unwrap_or(false);
    if dimensions_changed {
        let (columns, rows) = decision
            .requested_dimensions
            .expect("changed viewport dimensions must exist");
        session.pty.resize(columns, rows)?;
        session.headless.resize(columns, rows)?;
        let revision = session.headless.revision();
        for client in session.clients.values_mut() {
            client.needs_checkpoint = true;
            client
                .minimum_live_revision
                .store(revision, Ordering::Release);
        }
        enqueue_pending_checkpoint(session_name, session, chunk_bytes)?;
    }
    if decision.owner_changed || dimensions_changed {
        mark_viewport_status_pending(session);
    }
    enqueue_pending_viewport_statuses(session_name, session);
    Ok(())
}

fn mark_viewport_status_pending(session: &mut LiveSession) {
    for client in session.clients.values_mut() {
        client.needs_viewport_status = true;
    }
}

fn enqueue_pending_viewport_statuses(session_name: &str, session: &mut LiveSession) {
    let owner_client_id = session.viewport.owner_client_id();
    let owner_title = session
        .clients
        .get(&owner_client_id)
        .map(|client| client.title.clone())
        .unwrap_or_default();
    let dimensions = session.headless.dimensions();
    let ownership_epoch = session.viewport.ownership_epoch();
    let source_revision = session.headless.revision();
    for (client_id, client) in &mut session.clients {
        if !client.needs_viewport_status {
            continue;
        }
        let viewer = session.viewport.viewer(*client_id).unwrap_or_default();
        let frame = protocol::envelope(
            0,
            session_name,
            Payload::TerminalViewportStatus(TerminalViewportStatus {
                ownership_epoch,
                owner_client_id,
                owner_title: owner_title.clone(),
                is_owner: owner_client_id == *client_id,
                source_columns: dimensions.columns as u32,
                source_rows: dimensions.rows as u32,
                source_revision,
                view_columns: u32::from(viewer.columns),
                view_rows: u32::from(viewer.rows),
            }),
        );
        if client.tx.try_send(frame).is_ok() {
            client.needs_viewport_status = false;
        }
    }
}

pub(crate) async fn request_checkpoint(
    state: &Arc<Mutex<PtyManagerState>>,
    session_name: &str,
    client_id: u64,
    last_applied_revision: u64,
) -> Result<()> {
    let mut state = state.lock().await;
    let chunk_bytes = state.limits.checkpoint_chunk_bytes;
    let session = state
        .sessions
        .get_mut(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
    let revision = session.headless.revision();
    if last_applied_revision > revision {
        return Err(TerminalError::Protocol(
            "checkpoint request revision is ahead of the session".to_owned(),
        ));
    }
    let client = session
        .clients
        .get_mut(&client_id)
        .ok_or(TerminalError::ClientNotFound(client_id))?;
    client.needs_checkpoint = true;
    client
        .minimum_live_revision
        .store(revision, Ordering::Release);
    enqueue_pending_checkpoint(session_name, session, chunk_bytes)
}

pub(crate) async fn retry_pending_client_state(state: &Arc<Mutex<PtyManagerState>>) {
    let mut state = state.lock().await;
    let chunk_bytes = state.limits.checkpoint_chunk_bytes;
    for (session_name, session) in &mut state.sessions {
        if session
            .clients
            .values()
            .any(|client| client.needs_checkpoint)
        {
            let _ = enqueue_pending_checkpoint(session_name, session, chunk_bytes);
        }
        enqueue_pending_viewport_statuses(session_name, session);
    }
}

fn enqueue_pending_checkpoint(
    session_name: &str,
    session: &mut LiveSession,
    chunk_bytes: usize,
) -> Result<()> {
    let minimum_capacity = session
        .headless
        .checkpoint()?
        .ansi
        .len()
        .div_ceil(chunk_bytes)
        + 2;
    let ready_clients = session
        .clients
        .iter()
        .filter_map(|(client_id, client)| {
            (client.needs_checkpoint && client.tx.capacity() >= minimum_capacity)
                .then_some(*client_id)
        })
        .collect::<Vec<_>>();
    if ready_clients.is_empty() {
        return Ok(());
    }
    let frames = checkpoint_envelopes(session_name, session, chunk_bytes)?;
    let checkpoint_revision = frames
        .iter()
        .find_map(|frame| match frame.payload.as_ref() {
            Some(Payload::TerminalCheckpointBegin(begin)) => Some(begin.revision),
            _ => None,
        })
        .unwrap_or(session.headless.revision());
    for client_id in ready_clients {
        let Some(client) = session.clients.get_mut(&client_id) else {
            continue;
        };
        if client.tx.capacity() < frames.len() {
            continue;
        }
        client
            .minimum_live_revision
            .store(checkpoint_revision, Ordering::Release);
        let mut complete = true;
        for frame in &frames {
            if client.tx.try_send(frame.clone()).is_err() {
                complete = false;
                break;
            }
        }
        client.needs_checkpoint = !complete;
    }
    Ok(())
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
        let _ = client.tx.try_send(frame.clone());
        let _ = client.tx.try_send(protocol::envelope(
            0,
            session_name,
            Payload::ClientDetached(ClientDetached { client_id }),
        ));
        let _ = close_connection;
    }
    Ok(129)
}

pub(crate) async fn detach_client(
    state: &Arc<Mutex<PtyManagerState>>,
    reaper: &ReapScheduler,
    client_id: u64,
) -> Result<bool> {
    let mut state = state.lock().await;
    let Some(session_names) = state.client_sessions.remove(&client_id) else {
        return Ok(false);
    };
    let chunk_bytes = state.limits.checkpoint_chunk_bytes;
    let mut detached = false;
    let mut final_leases = Vec::new();
    for session_name in session_names {
        if let Some(session) = state.sessions.get_mut(&session_name) {
            let decision = session.viewport.remove(client_id)?;
            session.clients.remove(&client_id);
            apply_viewport_decision(&session_name, session, decision, chunk_bytes)?;
            detached = true;
            if session.lifetime == SessionLifetime::Leased && session.clients.is_empty() {
                final_leases.push(session_name);
            }
        }
    }
    for session_name in final_leases {
        state.schedule_reap(&session_name, reaper);
    }
    Ok(detached)
}

pub(crate) async fn close_client(
    state: &Arc<Mutex<PtyManagerState>>,
    reaper: &ReapScheduler,
    session_name: &str,
    client_id: u64,
) -> Result<()> {
    let (client, close_connection) = {
        let mut state = state.lock().await;
        let chunk_bytes = state.limits.checkpoint_chunk_bytes;
        let session = state
            .sessions
            .get_mut(session_name)
            .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_owned()))?;
        let client = session
            .clients
            .remove(&client_id)
            .ok_or(TerminalError::ClientNotFound(client_id))?;
        let decision = session.viewport.remove(client_id)?;
        apply_viewport_decision(session_name, session, decision, chunk_bytes)?;
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

    let _ = client.tx.try_send(protocol::envelope(
        0,
        session_name,
        Payload::ClientDetached(ClientDetached { client_id }),
    ));
    let _ = close_connection;
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
        let _ = client.tx.try_send(frame.clone());
    }
    true
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
        let _ = client.tx.try_send(exited.clone());
        let _ = client.tx.try_send(protocol::envelope(
            0,
            session_name,
            Payload::ClientDetached(ClientDetached { client_id }),
        ));
        let _ = close_connection;
    }
}

pub(crate) async fn subscribe_sessions(
    state: &Arc<Mutex<PtyManagerState>>,
    client_id: u64,
    client_tx: &mpsc::Sender<Envelope>,
) {
    let snapshot = {
        let mut state = state.lock().await;
        state.observers.insert(client_id, client_tx.clone());
        state.session_summaries()
    };
    let _ = client_tx.try_send(protocol::envelope(
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
        if observer.try_send(frame.clone()).is_err() {
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
