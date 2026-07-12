use std::collections::HashSet;
use std::path::Path;

use tokio::net::UnixStream;

use crate::error::{Result, TerminalError};
use crate::protocol::{
    self, ClientDetached, CloseClient, KillSession, ListSessions, Payload, SessionExited,
    SessionList, SessionSnapshot, SessionSummary, SubscribeSessions,
};
use crate::transport::{frame, receive, send, TerminalFramed};

pub async fn connect(socket_path: &Path) -> Result<TerminalFramed> {
    let stream = UnixStream::connect(socket_path).await?;
    Ok(frame(stream))
}

pub async fn list_sessions(socket_path: &Path) -> Result<Vec<SessionSummary>> {
    let mut framed = connect(socket_path).await?;
    send(
        &mut framed,
        &protocol::envelope(1, "", Payload::ListSessions(ListSessions {})),
    )
    .await?;

    let envelope = receive_required(&mut framed).await?;
    match protocol::payload(envelope)? {
        Payload::SessionList(SessionList { sessions }) => Ok(sessions),
        Payload::Error(error) => Err(TerminalError::Protocol(error.message)),
        _ => Err(TerminalError::Protocol(
            "unexpected list response".to_owned(),
        )),
    }
}

pub async fn kill_session(socket_path: &Path, session_name: &str) -> Result<i32> {
    let mut framed = connect(socket_path).await?;
    send(
        &mut framed,
        &protocol::envelope(1, session_name, Payload::KillSession(KillSession {})),
    )
    .await?;

    let envelope = receive_required(&mut framed).await?;
    match protocol::payload(envelope)? {
        Payload::SessionExited(SessionExited { status }) => Ok(status),
        Payload::Error(error) => Err(TerminalError::Protocol(error.message)),
        _ => Err(TerminalError::Protocol(
            "unexpected kill response".to_owned(),
        )),
    }
}

pub async fn close_client(socket_path: &Path, session_name: &str, client_id: u64) -> Result<u64> {
    let mut framed = connect(socket_path).await?;
    send(
        &mut framed,
        &protocol::envelope(
            1,
            session_name,
            Payload::CloseClient(CloseClient { client_id }),
        ),
    )
    .await?;

    let envelope = receive_required(&mut framed).await?;
    match protocol::payload(envelope)? {
        Payload::ClientDetached(ClientDetached { client_id }) => Ok(client_id),
        Payload::Error(error) => Err(TerminalError::Protocol(error.message)),
        _ => Err(TerminalError::Protocol(
            "unexpected close client response".to_owned(),
        )),
    }
}

pub async fn subscribe_sessions(socket_path: &Path) -> Result<TerminalFramed> {
    let mut framed = connect(socket_path).await?;
    send(
        &mut framed,
        &protocol::envelope(1, "", Payload::SubscribeSessions(SubscribeSessions {})),
    )
    .await?;
    Ok(framed)
}

pub async fn receive_session_snapshot(framed: &mut TerminalFramed) -> Result<Vec<SessionSummary>> {
    let envelope = receive_required(framed).await?;
    match protocol::payload(envelope)? {
        Payload::SessionSnapshot(SessionSnapshot { sessions }) => Ok(sessions),
        Payload::Error(error) => Err(TerminalError::Protocol(error.message)),
        _ => Err(TerminalError::Protocol(
            "unexpected session snapshot response".to_owned(),
        )),
    }
}

pub async fn next_numeric_session_name(socket_path: &Path) -> Result<String> {
    let sessions = list_sessions(socket_path).await?;
    let used = sessions
        .into_iter()
        .map(|session| session.name)
        .collect::<HashSet<_>>();
    for index in 0_u32.. {
        let name = index.to_string();
        if !used.contains(&name) {
            return Ok(name);
        }
    }
    unreachable!("u32 iteration cannot exhaust in a practical session")
}

async fn receive_required(framed: &mut TerminalFramed) -> Result<protocol::Envelope> {
    receive(framed)
        .await?
        .ok_or_else(|| TerminalError::Protocol("pty manager closed the connection".to_owned()))
}
