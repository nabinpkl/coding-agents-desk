use std::collections::BTreeMap;

use crate::error::{Result, TerminalError};
use crate::protocol::{
    validate_session_name, ClientSummary, SessionLifetime, SessionState, SessionSummary,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub name: String,
    pub cwd: String,
    pub shell: String,
    pub pid: u32,
    pub lifetime: SessionLifetime,
    pub started_at_unix_milliseconds: u64,
    pub state: SessionLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLifecycle {
    Running,
    Exited,
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: BTreeMap<String, SessionRecord>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ensure_running(
        &mut self,
        name: &str,
        cwd: impl Into<String>,
        shell: impl Into<String>,
        pid: u32,
        lifetime: SessionLifetime,
        started_at_unix_milliseconds: u64,
    ) -> Result<bool> {
        validate_session_name(name)?;
        if let Some(existing) = self.sessions.get(name) {
            if existing.state == SessionLifecycle::Running {
                return Ok(false);
            }
        }

        self.sessions.insert(
            name.to_owned(),
            SessionRecord {
                name: name.to_owned(),
                cwd: cwd.into(),
                shell: shell.into(),
                pid,
                lifetime,
                started_at_unix_milliseconds,
                state: SessionLifecycle::Running,
            },
        );
        Ok(true)
    }

    pub fn mark_exited(&mut self, name: &str) -> Result<()> {
        let record = self
            .sessions
            .get_mut(name)
            .ok_or_else(|| TerminalError::SessionNotFound(name.to_owned()))?;
        record.state = SessionLifecycle::Exited;
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> Result<SessionRecord> {
        self.sessions
            .remove(name)
            .ok_or_else(|| TerminalError::SessionNotFound(name.to_owned()))
    }

    pub fn list(
        &self,
        clients_by_session: &BTreeMap<String, Vec<ClientSummary>>,
    ) -> Vec<SessionSummary> {
        self.list_with_runtime(clients_by_session, &BTreeMap::new())
    }

    pub fn list_with_runtime(
        &self,
        clients_by_session: &BTreeMap<String, Vec<ClientSummary>>,
        runtime_by_session: &BTreeMap<String, (u32, u32, u64, u64, u64)>,
    ) -> Vec<SessionSummary> {
        self.sessions
            .values()
            .filter(|record| record.state == SessionLifecycle::Running)
            .map(|record| {
                let (columns, rows, revision, owner_client_id, ownership_epoch) =
                    runtime_by_session
                        .get(&record.name)
                        .copied()
                        .unwrap_or_default();
                SessionSummary {
                    name: record.name.clone(),
                    cwd: record.cwd.clone(),
                    shell: record.shell.clone(),
                    pid: record.pid,
                    state: SessionState::Running as i32,
                    clients: clients_by_session
                        .get(&record.name)
                        .cloned()
                        .unwrap_or_default(),
                    lifetime: record.lifetime as i32,
                    started_at_unix_milliseconds: record.started_at_unix_milliseconds,
                    columns,
                    rows,
                    revision,
                    owner_client_id,
                    ownership_epoch,
                }
            })
            .collect()
    }
}
