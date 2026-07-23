use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::error::{Result, TerminalError};
use crate::fd_transfer::{receive_message, send_message};
use crate::vault_protocol::generated::{
    create_session, vault_request, vault_response, Acknowledged, CommandLaunch, CreateSession,
    ExitStatus, KillSession, LeaseSession, ListSessions, QueryExitStatus, ResizeSession, Session,
    ShellLaunch, VaultRequest, VaultResponse,
};
use crate::vault_protocol::VAULT_PROTOCOL_VERSION;

#[derive(Clone)]
pub struct VaultClient {
    inner: Arc<VaultClientInner>,
}

struct VaultClientInner {
    socket_path: PathBuf,
    next_request_id: AtomicU64,
}

pub enum VaultLaunch {
    Shell {
        cwd: String,
        shell: String,
    },
    Command {
        cwd: String,
        executable: String,
        arguments: Vec<String>,
    },
}

pub struct VaultLease {
    pub session: Session,
    pub descriptor: OwnedFd,
}

impl VaultClient {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            inner: Arc::new(VaultClientInner {
                socket_path: socket_path.into(),
                next_request_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.inner.socket_path
    }

    pub fn create(
        &self,
        name: &str,
        launch: VaultLaunch,
        columns: u16,
        rows: u16,
        lifetime: i32,
    ) -> Result<VaultLease> {
        let launch = match launch {
            VaultLaunch::Shell { cwd, shell } => {
                create_session::Launch::ShellLaunch(ShellLaunch { cwd, shell })
            }
            VaultLaunch::Command {
                cwd,
                executable,
                arguments,
            } => create_session::Launch::CommandLaunch(CommandLaunch {
                cwd,
                executable,
                arguments,
            }),
        };
        let (response, descriptor) =
            self.request(vault_request::Payload::CreateSession(CreateSession {
                name: name.to_owned(),
                columns: u32::from(columns),
                rows: u32::from(rows),
                lifetime,
                launch: Some(launch),
            }))?;
        lease_response(response, descriptor)
    }

    pub fn list(&self) -> Result<Vec<Session>> {
        let (response, descriptor) =
            self.request(vault_request::Payload::ListSessions(ListSessions {}))?;
        if descriptor.is_some() {
            return Err(TerminalError::Protocol(
                "vault list returned unexpected descriptor".to_owned(),
            ));
        }
        match response.payload {
            Some(vault_response::Payload::SessionList(list)) => Ok(list.sessions),
            _ => Err(TerminalError::Protocol(
                "vault list response missing session list".to_owned(),
            )),
        }
    }

    pub fn lease(&self, name: &str, generation: u64) -> Result<VaultLease> {
        let (response, descriptor) =
            self.request(vault_request::Payload::LeaseSession(LeaseSession {
                name: name.to_owned(),
                generation,
            }))?;
        lease_response(response, descriptor)
    }

    pub fn resize(&self, name: &str, generation: u64, columns: u16, rows: u16) -> Result<()> {
        let (response, descriptor) =
            self.request(vault_request::Payload::ResizeSession(ResizeSession {
                name: name.to_owned(),
                generation,
                columns: u32::from(columns),
                rows: u32::from(rows),
            }))?;
        acknowledged_response(response, descriptor)
    }

    pub fn kill(&self, name: &str, generation: u64) -> Result<i32> {
        let (response, descriptor) =
            self.request(vault_request::Payload::KillSession(KillSession {
                name: name.to_owned(),
                generation,
            }))?;
        exit_response(response, descriptor).and_then(|status| {
            status.exited.then_some(status.status).ok_or_else(|| {
                TerminalError::Protocol("vault kill left session running".to_owned())
            })
        })
    }

    pub fn exit_status(
        &self,
        name: &str,
        generation: u64,
        acknowledge: bool,
    ) -> Result<Option<i32>> {
        let (response, descriptor) =
            self.request(vault_request::Payload::QueryExitStatus(QueryExitStatus {
                name: name.to_owned(),
                generation,
                acknowledge,
            }))?;
        let status = exit_response(response, descriptor)?;
        Ok(status.exited.then_some(status.status))
    }

    fn request(&self, payload: vault_request::Payload) -> Result<(VaultResponse, Option<OwnedFd>)> {
        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request = VaultRequest {
            protocol_version: VAULT_PROTOCOL_VERSION,
            request_id,
            payload: Some(payload),
        };
        let mut stream = UnixStream::connect(&self.inner.socket_path)?;
        send_message(&mut stream, &request, None)?;
        let (response, descriptor) = receive_message::<VaultResponse>(&mut stream)?;
        if response.protocol_version != VAULT_PROTOCOL_VERSION {
            return Err(TerminalError::Protocol(
                "vault protocol version mismatch".to_owned(),
            ));
        }
        if response.request_id != request_id {
            return Err(TerminalError::Protocol(
                "vault response request id mismatch".to_owned(),
            ));
        }
        if !response.error.is_empty() {
            return Err(TerminalError::Pty(response.error));
        }
        Ok((response, descriptor))
    }
}

fn lease_response(response: VaultResponse, descriptor: Option<OwnedFd>) -> Result<VaultLease> {
    let session = match response.payload {
        Some(vault_response::Payload::SessionLease(lease)) => lease.session.ok_or_else(|| {
            TerminalError::Protocol("vault lease response missing session".to_owned())
        })?,
        _ => {
            return Err(TerminalError::Protocol(
                "vault response missing session lease".to_owned(),
            ))
        }
    };
    let descriptor = descriptor.ok_or_else(|| {
        TerminalError::Protocol("vault lease response missing descriptor".to_owned())
    })?;
    Ok(VaultLease {
        session,
        descriptor,
    })
}

fn acknowledged_response(response: VaultResponse, descriptor: Option<OwnedFd>) -> Result<()> {
    if descriptor.is_some() {
        return Err(TerminalError::Protocol(
            "vault acknowledgement returned unexpected descriptor".to_owned(),
        ));
    }
    match response.payload {
        Some(vault_response::Payload::Acknowledged(Acknowledged {})) => Ok(()),
        _ => Err(TerminalError::Protocol(
            "vault response missing acknowledgement".to_owned(),
        )),
    }
}

fn exit_response(response: VaultResponse, descriptor: Option<OwnedFd>) -> Result<ExitStatus> {
    if descriptor.is_some() {
        return Err(TerminalError::Protocol(
            "vault exit response returned unexpected descriptor".to_owned(),
        ));
    }
    match response.payload {
        Some(vault_response::Payload::ExitStatus(status)) => Ok(status),
        _ => Err(TerminalError::Protocol(
            "vault response missing exit status".to_owned(),
        )),
    }
}
