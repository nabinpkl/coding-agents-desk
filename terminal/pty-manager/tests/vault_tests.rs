#![cfg(target_os = "macos")]

use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pty_manager::vault::{Vault, VaultOptions};
use pty_manager::vault_client::{VaultClient, VaultLaunch};
use tempfile::{tempdir, TempDir};

#[test]
fn vault_owns_primary_descriptor_and_leases_live_session() {
    let vault = RunningVault::start(4);
    let client = VaultClient::new(vault.socket_path());
    let created = client
        .create(
            "main",
            VaultLaunch::Command {
                cwd: vault.root().to_string_lossy().into_owned(),
                executable: "/bin/sh".to_owned(),
                arguments: vec![
                    "-c".to_owned(),
                    "printf 'ready:%s\\n' \"$$\"; IFS= read -r line; printf 'reply:%s\\n' \"$line\"; exit 7"
                        .to_owned(),
                ],
            },
            80,
            24,
            1,
        )
        .expect("create session");
    let pid = created.session.pid;
    let generation = created.session.generation;
    let mut first = std::fs::File::from(created.descriptor);
    assert!(read_until(&mut first, "ready:", Duration::from_secs(2)).contains(&pid.to_string()));

    let second = client.lease("main", generation).expect("second lease");
    assert_eq!(second.session.pid, pid);
    assert_ne!(first.as_raw_fd(), second.descriptor.as_raw_fd());
    drop(first);
    let mut second = std::fs::File::from(second.descriptor);
    assert!(process_exists(pid), "vault did not retain child");

    client
        .resize("main", generation, 100, 40)
        .expect("resize session");
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::ioctl(second.as_raw_fd(), libc::TIOCGWINSZ, &mut size) },
        0
    );
    assert_eq!((size.ws_col, size.ws_row), (100, 40));

    second.write_all(b"after-vault\n").expect("write PTY");
    second.flush().expect("flush PTY");
    assert!(
        read_until(&mut second, "reply:after-vault", Duration::from_secs(2))
            .contains("reply:after-vault")
    );
    assert_eq!(
        wait_for_exit_status(&client, "main", generation, true),
        Some(7)
    );
    assert!(client.list().expect("list after exit").is_empty());
}

#[test]
fn vault_rejects_stale_generation_and_enforces_session_bound() {
    let vault = RunningVault::start(1);
    let client = VaultClient::new(vault.socket_path());
    let session = client
        .create("first", waiting_launch(vault.root()), 80, 24, 1)
        .expect("create first");
    let stale = session.session.generation.wrapping_add(1);
    assert!(client.resize("first", stale, 90, 30).is_err());
    assert!(client.kill("first", stale).is_err());
    assert!(client
        .create("second", waiting_launch(vault.root()), 80, 24, 1,)
        .is_err());
    assert_eq!(
        client
            .kill("first", session.session.generation)
            .expect("kill first"),
        129
    );
    drop(session);
}

#[test]
fn vault_socket_is_private_to_the_user() {
    let vault = RunningVault::start(1);
    let mode = fs::metadata(vault.socket_path())
        .expect("vault socket metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}

fn waiting_launch(root: &Path) -> VaultLaunch {
    VaultLaunch::Command {
        cwd: root.to_string_lossy().into_owned(),
        executable: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), "while :; do sleep 1; done".to_owned()],
    }
}

fn wait_for_exit_status(
    client: &VaultClient,
    name: &str,
    generation: u64,
    acknowledge: bool,
) -> Option<i32> {
    for _ in 0..200 {
        if let Some(status) = client
            .exit_status(name, generation, acknowledge)
            .expect("query exit")
        {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
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
        assert!(ready >= 0);
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
            Err(error) => panic!("vault PTY read failed: {error}"),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn process_exists(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

struct RunningVault {
    root: TempDir,
    socket_path: std::path::PathBuf,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl RunningVault {
    fn start(max_sessions: usize) -> Self {
        let root = tempdir().expect("vault root");
        let socket_path = root.path().join("pty-vault.sock");
        let shutdown = Arc::new(AtomicBool::new(false));
        let vault = Vault::new(VaultOptions {
            socket_path: socket_path.clone(),
            max_sessions,
        })
        .expect("create vault");
        let thread_shutdown = shutdown.clone();
        let thread = std::thread::spawn(move || {
            vault.run_until(thread_shutdown).expect("run vault");
        });
        let readiness_client = VaultClient::new(socket_path.clone());
        for _ in 0..200 {
            if readiness_client.list().is_ok() {
                return Self {
                    root,
                    socket_path,
                    shutdown,
                    thread: Some(thread),
                };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("vault socket did not appear");
    }

    fn root(&self) -> &Path {
        self.root.path()
    }

    fn socket_path(&self) -> &Path {
        &self.socket_path
    }
}

impl Drop for RunningVault {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join vault");
        }
    }
}
