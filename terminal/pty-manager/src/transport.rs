use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::UnixStream;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::error::{Result, TerminalError};
use crate::protocol::{decode, encode, Envelope};

pub type TerminalFramed = Framed<UnixStream, LengthDelimitedCodec>;

pub fn frame(stream: UnixStream) -> TerminalFramed {
    Framed::new(stream, LengthDelimitedCodec::new())
}

pub async fn send(framed: &mut TerminalFramed, envelope: &Envelope) -> Result<()> {
    framed.send(encode(envelope)?).await.map_err(to_io_error)
}

pub async fn receive(framed: &mut TerminalFramed) -> Result<Option<Envelope>> {
    match framed.next().await {
        Some(Ok(bytes)) => Ok(Some(decode(&bytes)?)),
        Some(Err(error)) => Err(to_io_error(error)),
        None => Ok(None),
    }
}

fn to_io_error(error: std::io::Error) -> TerminalError {
    TerminalError::Io(error)
}

pub fn bytes_frame(data: Vec<u8>) -> Bytes {
    Bytes::from(data)
}
