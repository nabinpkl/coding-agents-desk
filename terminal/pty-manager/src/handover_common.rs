use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

use crate::error::{Result, TerminalError};
use crate::fd_transfer::{receive_message, send_message};
use crate::runtime_config::handover_timeout;
use crate::vault_protocol::generated::{handover_phase, HandoverPhase};

pub(crate) fn configure_stream(stream: &UnixStream) -> Result<()> {
    let timeout = handover_timeout()?;
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok(())
}

pub(crate) fn validate_same_euid_peer(stream: &UnixStream, label: &str) -> Result<()> {
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if uid != unsafe { libc::geteuid() } {
        return Err(TerminalError::Protocol(format!(
            "{label} peer uid mismatch"
        )));
    }
    Ok(())
}

pub(crate) fn send_phase(stream: &mut UnixStream, phase: handover_phase::Phase) -> Result<()> {
    send_message(
        stream,
        &HandoverPhase {
            phase: phase as i32,
        },
        None,
    )
}

pub(crate) fn expect_phase(
    stream: &mut UnixStream,
    expected: handover_phase::Phase,
    label: &str,
) -> Result<()> {
    let (phase, descriptor) = receive_message::<HandoverPhase>(stream)?;
    if descriptor.is_some() || phase.phase != expected as i32 {
        return Err(TerminalError::Protocol(format!(
            "expected {label} handover phase {expected:?}"
        )));
    }
    Ok(())
}

pub(crate) fn checksum(bytes: impl Iterator<Item = u8>) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
