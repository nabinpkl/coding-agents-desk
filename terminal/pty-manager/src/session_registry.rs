use std::collections::BTreeMap;

use crate::error::{Result, TerminalError};
use crate::protocol::{validate_session_name, ClientSummary, SessionState, SessionSummary};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub name: String,
    pub cwd: String,
    pub shell: String,
    pub pid: u32,
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
        self.sessions
            .values()
            .filter(|record| record.state == SessionLifecycle::Running)
            .map(|record| SessionSummary {
                name: record.name.clone(),
                cwd: record.cwd.clone(),
                shell: record.shell.clone(),
                pid: record.pid,
                state: SessionState::Running as i32,
                clients: clients_by_session
                    .get(&record.name)
                    .cloned()
                    .unwrap_or_default(),
            })
            .collect()
    }
}
