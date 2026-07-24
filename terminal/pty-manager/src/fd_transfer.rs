use std::io::{Read, Write};
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

use prost::Message;

use crate::error::{Result, TerminalError};

pub const MAX_HANDOVER_FRAME_BYTES: usize = 32 * 1024 * 1024;

pub fn send_message<M: Message>(
    stream: &mut UnixStream,
    message: &M,
    descriptor: Option<RawFd>,
) -> Result<()> {
    let bytes = message.encode_to_vec();
    if bytes.len() > MAX_HANDOVER_FRAME_BYTES {
        return Err(TerminalError::Protocol(
            "handover frame exceeds byte limit".to_owned(),
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| TerminalError::Protocol("handover frame length overflow".to_owned()))?
        .to_be_bytes();

    if let Some(descriptor) = descriptor {
        send_header_with_descriptor(stream, &length, descriptor)?;
    } else {
        stream.write_all(&length)?;
    }
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

pub fn receive_message<M: Message + Default>(
    stream: &mut UnixStream,
) -> Result<(M, Option<OwnedFd>)> {
    let (length, descriptor) = receive_header_and_descriptor(stream)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_HANDOVER_FRAME_BYTES {
        return Err(TerminalError::Protocol(
            "handover frame exceeds byte limit".to_owned(),
        ));
    }
    let mut bytes = vec![0_u8; length];
    stream.read_exact(&mut bytes)?;
    Ok((M::decode(bytes.as_slice())?, descriptor))
}

fn send_header_with_descriptor(
    stream: &UnixStream,
    header: &[u8; 4],
    descriptor: RawFd,
) -> Result<()> {
    let mut io = libc::iovec {
        iov_base: header.as_ptr().cast_mut().cast(),
        iov_len: header.len(),
    };
    let control_length = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) } as usize;
    let mut control = vec![0_u8; control_length];
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut io;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len() as _;

    unsafe {
        let control_header = libc::CMSG_FIRSTHDR(&message);
        if control_header.is_null() {
            return Err(TerminalError::Protocol(
                "failed to allocate descriptor control header".to_owned(),
            ));
        }
        (*control_header).cmsg_level = libc::SOL_SOCKET;
        (*control_header).cmsg_type = libc::SCM_RIGHTS;
        (*control_header).cmsg_len = libc::CMSG_LEN(mem::size_of::<RawFd>() as u32) as _;
        (libc::CMSG_DATA(control_header) as *mut RawFd).write(descriptor);
    }

    let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
    if sent < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if sent as usize != header.len() {
        return Err(TerminalError::Protocol(
            "partial handover descriptor header".to_owned(),
        ));
    }
    Ok(())
}

fn receive_header_and_descriptor(stream: &UnixStream) -> Result<([u8; 4], Option<OwnedFd>)> {
    let mut header = [0_u8; 4];
    let mut io = libc::iovec {
        iov_base: header.as_mut_ptr().cast(),
        iov_len: header.len(),
    };
    let control_length = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) } as usize;
    let mut control = vec![0_u8; control_length];
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut io;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len() as _;

    let received = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_WAITALL) };
    if received < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if received == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "handover socket closed",
        )
        .into());
    }
    if received as usize != header.len() {
        return Err(TerminalError::Protocol(
            "partial handover descriptor header".to_owned(),
        ));
    }
    if message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
        return Err(TerminalError::Protocol(
            "truncated handover descriptor frame".to_owned(),
        ));
    }

    let mut descriptor = None;
    unsafe {
        let mut control_header = libc::CMSG_FIRSTHDR(&message);
        while !control_header.is_null() {
            if (*control_header).cmsg_level == libc::SOL_SOCKET
                && (*control_header).cmsg_type == libc::SCM_RIGHTS
            {
                if descriptor.is_some() {
                    return Err(TerminalError::Protocol(
                        "handover frame contains multiple descriptors".to_owned(),
                    ));
                }
                let raw = (libc::CMSG_DATA(control_header) as *const RawFd).read();
                if raw < 0 {
                    return Err(TerminalError::Protocol(
                        "handover frame contains invalid descriptor".to_owned(),
                    ));
                }
                let flags = libc::fcntl(raw, libc::F_GETFD);
                if flags < 0 || libc::fcntl(raw, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
                    libc::close(raw);
                    return Err(std::io::Error::last_os_error().into());
                }
                descriptor = Some(OwnedFd::from_raw_fd(raw));
            }
            control_header = libc::CMSG_NXTHDR(&message, control_header);
        }
    }
    Ok((header, descriptor))
}

pub fn duplicate_descriptor(descriptor: RawFd) -> Result<OwnedFd> {
    let duplicate = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}
