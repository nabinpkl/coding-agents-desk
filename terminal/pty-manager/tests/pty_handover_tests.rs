#![cfg(target_os = "macos")]

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use prost::Message;

#[derive(Clone, PartialEq, Message)]
struct OwnerFrame {
    #[prost(uint32, tag = "1")]
    pid: u32,
    #[prost(int32, tag = "2")]
    process_group: i32,
}

#[test]
fn pty_owner_helper_entry() {
    if std::env::var_os("AGENTDESK_PTY_OWNER_HELPER").is_none() {
        return;
    }
    let socket_fd = std::env::var("AGENTDESK_PTY_OWNER_SOCKET_FD")
        .expect("helper socket fd")
        .parse::<RawFd>()
        .expect("parse helper socket fd");
    let mut socket = unsafe { UnixStream::from_raw_fd(socket_fd) };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open pty");
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "printf 'ready:%s\\n' \"$$\"; IFS= read -r line; printf 'reply:%s\\n' \"$line\"; exit 7",
    ]);
    let child = pair.slave.spawn_command(command).expect("spawn pty child");
    let pid = child.process_id().expect("child pid");
    let process_group = pair
        .master
        .process_group_leader()
        .expect("pty process group");
    let master_fd = pair.master.as_raw_fd().expect("master descriptor");
    pty_manager::fd_transfer::send_message(
        &mut socket,
        &OwnerFrame { pid, process_group },
        Some(master_fd),
    )
    .expect("transfer master descriptor");
    drop(child);
    drop(pair);
}

#[test]
fn live_pty_survives_owner_binary_exit_and_keeps_io_resize_and_status() {
    let (mut receiver, helper_socket) = UnixStream::pair().expect("socket pair");
    let socket_fd = helper_socket.as_raw_fd();
    let descriptor_flags = unsafe { libc::fcntl(socket_fd, libc::F_GETFD) };
    assert!(descriptor_flags >= 0);
    assert_eq!(
        unsafe {
            libc::fcntl(
                socket_fd,
                libc::F_SETFD,
                descriptor_flags & !libc::FD_CLOEXEC,
            )
        },
        0
    );
    let mut helper = Command::new(std::env::current_exe().expect("current test binary"))
        .args(["--exact", "pty_owner_helper_entry", "--nocapture"])
        .env("AGENTDESK_PTY_OWNER_HELPER", "1")
        .env("AGENTDESK_PTY_OWNER_SOCKET_FD", socket_fd.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn owner helper");
    drop(helper_socket);

    let (owner, master) = pty_manager::fd_transfer::receive_message::<OwnerFrame>(&mut receiver)
        .expect("receive PTY master");
    let mut master = std::fs::File::from(master.expect("master descriptor"));
    let helper_status = helper.wait().expect("wait owner helper");
    assert!(helper_status.success());
    assert!(process_exists(owner.pid));

    let ready = read_until(&mut master, "ready:", Duration::from_secs(2));
    assert!(
        ready.contains(&owner.pid.to_string()),
        "child PID missing from PTY output: {ready:?}"
    );
    assert_eq!(
        unsafe { libc::tcgetpgrp(master.as_raw_fd()) },
        owner.process_group
    );

    let size = libc::winsize {
        ws_row: 40,
        ws_col: 100,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    assert_eq!(
        unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) },
        0
    );

    master.write_all(b"after-handover\n").expect("write PTY");
    master.flush().expect("flush PTY");
    let reply = read_until(&mut master, "reply:after-handover", Duration::from_secs(2));
    assert!(
        reply.contains("reply:after-handover"),
        "replacement did not receive child output: {reply:?}"
    );
    let status =
        pty_manager::process_observer::observe_exit_status(owner.pid).expect("observe child exit");
    assert_eq!(status, 7);
}

fn read_until(file: &mut std::fs::File, expected: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    while Instant::now() < deadline {
        let mut descriptor = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut descriptor, 1, 50) };
        assert!(
            ready >= 0,
            "PTY poll failed: {}",
            std::io::Error::last_os_error()
        );
        if ready == 0 {
            continue;
        }
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                bytes.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&bytes);
                if text.contains(expected) {
                    return text.into_owned();
                }
            }
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => panic!("PTY read failed: {error}"),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn process_exists(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}
