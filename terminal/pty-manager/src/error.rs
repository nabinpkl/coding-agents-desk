use thiserror::Error;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("missing frame payload")]
    MissingPayload,
    #[error("invalid session name: {0}")]
    InvalidSessionName(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("client not found: {0}")]
    ClientNotFound(u64),
    #[error("session already exited: {0}")]
    SessionExited(String),
    #[error("pty manager already listening at {0}")]
    ManagerAlreadyListening(String),
    #[error("refusing to replace non-socket path: {0}")]
    NonSocketPath(String),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("io error")]
    Io(#[from] std::io::Error),
    #[error("encode error")]
    Encode(#[from] prost::EncodeError),
    #[error("decode error")]
    Decode(#[from] prost::DecodeError),
}

pub type Result<T> = std::result::Result<T, TerminalError>;
