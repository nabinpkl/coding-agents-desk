use bytes::Bytes;
use prost::Message;

use crate::error::{Result, TerminalError};

pub const PROTOCOL_VERSION: u32 = 5;

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/pty.v1.rs"));
}

pub use generated::create_or_attach;
pub use generated::envelope::Payload;
pub use generated::{
    Attached, ClientDetached, ClientSummary, CloseClient, CommandLaunch, CreateOrAttach, Detach,
    Envelope, Error, Hello, Input, KillSession, ListSessions, Output, Resize, SessionExited,
    SessionLifetime, SessionList, SessionSnapshot, SessionState, SessionSummary, ShellLaunch,
    SubscribeSessions,
};

pub fn envelope(request_id: u64, session_name: impl Into<String>, payload: Payload) -> Envelope {
    Envelope {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        session_name: session_name.into(),
        payload: Some(payload),
    }
}

pub fn encode(envelope: &Envelope) -> Result<Bytes> {
    Ok(Bytes::from(envelope.encode_to_vec()))
}

pub fn decode(bytes: &[u8]) -> Result<Envelope> {
    let envelope = Envelope::decode(bytes)?;
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(TerminalError::Protocol(format!(
            "unsupported protocol version {}",
            envelope.protocol_version
        )));
    }
    Ok(envelope)
}

pub fn payload(envelope: Envelope) -> Result<Payload> {
    envelope.payload.ok_or(TerminalError::MissingPayload)
}

pub fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn validate_session_name(name: &str) -> Result<()> {
    if valid_session_name(name) {
        Ok(())
    } else {
        Err(TerminalError::InvalidSessionName(name.to_owned()))
    }
}

pub fn error_envelope(
    request_id: u64,
    session_name: impl Into<String>,
    message: String,
) -> Envelope {
    envelope(request_id, session_name, Payload::Error(Error { message }))
}
