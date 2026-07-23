use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

use prost::Message;
use tempfile::tempfile;

#[derive(Clone, PartialEq, Message)]
struct TestFrame {
    #[prost(string, tag = "1")]
    value: String,
}

#[test]
fn transfers_one_cloexec_descriptor_with_its_frame() {
    let (mut sender, mut receiver) = UnixStream::pair().expect("socket pair");
    let mut source = tempfile().expect("source file");
    source.write_all(b"vault-bytes").expect("write source");
    source.seek(SeekFrom::Start(0)).expect("rewind source");

    pty_manager::fd_transfer::send_message(
        &mut sender,
        &TestFrame {
            value: "session-main".to_owned(),
        },
        Some(source.as_raw_fd()),
    )
    .expect("send descriptor frame");

    let (frame, descriptor) = pty_manager::fd_transfer::receive_message::<TestFrame>(&mut receiver)
        .expect("receive descriptor frame");
    assert_eq!(frame.value, "session-main");
    let mut received = std::fs::File::from(descriptor.expect("received descriptor"));
    let mut text = String::new();
    received.read_to_string(&mut text).expect("read descriptor");
    assert_eq!(text, "vault-bytes");
    let flags = unsafe { libc::fcntl(received.as_raw_fd(), libc::F_GETFD) };
    assert_ne!(flags & libc::FD_CLOEXEC, 0);
}

#[test]
fn rejects_frames_above_the_handover_bound() {
    let (mut sender, _receiver) = UnixStream::pair().expect("socket pair");
    let error = pty_manager::fd_transfer::send_message(
        &mut sender,
        &TestFrame {
            value: "x".repeat(pty_manager::fd_transfer::MAX_HANDOVER_FRAME_BYTES),
        },
        None,
    )
    .expect_err("oversized frame must fail");
    assert!(error.to_string().contains("exceeds byte limit"));
}
