#![cfg(target_os = "macos")]

use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use prost::Message;
use pty_manager::vault::{Vault, VaultOptions};
use pty_manager::vault_client::{VaultClient, VaultLaunch};
use pty_manager::vault_protocol::generated::{
    handover_phase, vault_request, BeginHandover, HandoverPhase, VaultHandoverDescriptor,
    VaultHandoverManifest, VaultRequest, VaultResponse,
};
use pty_manager::vault_protocol::VAULT_PROTOCOL_VERSION;
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
fn vault_rejects_import_with_reused_or_missing_child_pid() {
    let origin = RunningVault::start(1);
    let target = RunningVault::start(1);
    let origin_client = VaultClient::new(origin.socket_path());
    let target_client = VaultClient::new(target.socket_path());
    let lease = origin_client
        .create("main", waiting_launch(origin.root()), 80, 24, 1)
        .expect("create source session");
    let mut forged = lease.session.clone();
    forged.pid = u32::MAX;
    assert!(target_client.import(forged, &lease.descriptor).is_err());
    assert!(target_client.list().expect("list target vault").is_empty());
    origin_client
        .kill("main", lease.session.generation)
        .expect("cleanup source session");
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

#[test]
fn vault_candidate_inherits_listener_sessions_and_exact_exit() {
    let mut old = RunningVault::start(4);
    let client = VaultClient::new(old.socket_path());
    let created = client
        .create(
            "handover",
            VaultLaunch::Command {
                cwd: old.root().to_string_lossy().into_owned(),
                executable: "/bin/sh".to_owned(),
                arguments: vec![
                    "-c".to_owned(),
                    "printf 'ready\\n'; while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; [ \"$line\" = quit ] && exit 23; done"
                        .to_owned(),
                ],
            },
            80,
            24,
            1,
        )
        .expect("create handover session");
    let pid = created.session.pid;
    let process_group = created.session.process_group;
    let generation = created.session.generation;
    let mut original_lease = std::fs::File::from(created.descriptor);
    assert!(read_until(&mut original_lease, "ready", Duration::from_secs(2)).contains("ready"));

    let candidate_shutdown = Arc::new(AtomicBool::new(false));
    let candidate_options = VaultOptions {
        socket_path: old.socket_path().to_path_buf(),
        max_sessions: 4,
    };
    let thread_shutdown = candidate_shutdown.clone();
    let candidate = std::thread::spawn(move || {
        Vault::handover_until(candidate_options, thread_shutdown).expect("run candidate vault");
    });
    old.wait_for_handover();

    let inherited = client.list().expect("list through inherited listener");
    assert_eq!(inherited.len(), 1);
    assert_eq!(inherited[0].pid, pid);
    assert_eq!(inherited[0].process_group, process_group);
    assert_eq!(inherited[0].generation, generation);
    let replacement_lease = client
        .lease("handover", generation)
        .expect("lease from candidate");
    assert_eq!(replacement_lease.session.pid, pid);
    drop(replacement_lease);

    original_lease
        .write_all(b"after-handover\n")
        .expect("write after handover");
    original_lease.flush().expect("flush after handover");
    assert!(read_until(
        &mut original_lease,
        "reply:after-handover",
        Duration::from_secs(2)
    )
    .contains("reply:after-handover"));
    original_lease.write_all(b"quit\n").expect("write quit");
    original_lease.flush().expect("flush quit");
    assert!(
        read_until(&mut original_lease, "reply:quit", Duration::from_secs(2))
            .contains("reply:quit")
    );
    assert_eq!(
        wait_for_exit_status(&client, "handover", generation, true),
        Some(23)
    );
    println!(
        "{{\"component\":\"vault\",\"pid\":{pid},\"processGroup\":{process_group},\"sessionGeneration\":{generation},\"vaultGenerationBefore\":1,\"vaultGenerationAfter\":2,\"exitStatus\":23,\"preserved\":true}}"
    );

    candidate_shutdown.store(true, Ordering::Release);
    candidate.join().expect("join candidate vault");
}

#[test]
fn vault_handover_preserves_many_session_descriptors() {
    let mut old = RunningVault::start(4);
    let client = VaultClient::new(old.socket_path());
    let mut expected = Vec::new();
    for name in ["one", "two", "three"] {
        let lease = client
            .create(name, waiting_launch(old.root()), 80, 24, 1)
            .expect("create session before many-session handover");
        expected.push((
            name.to_owned(),
            lease.session.pid,
            lease.session.process_group,
            lease.session.generation,
        ));
        drop(lease);
    }

    let candidate_shutdown = Arc::new(AtomicBool::new(false));
    let candidate_options = VaultOptions {
        socket_path: old.socket_path().to_path_buf(),
        max_sessions: 4,
    };
    let thread_shutdown = candidate_shutdown.clone();
    let candidate = std::thread::spawn(move || {
        Vault::handover_until(candidate_options, thread_shutdown).expect("run candidate vault");
    });
    old.wait_for_handover();

    let mut inherited = client.list().expect("list inherited sessions");
    inherited.sort_by(|left, right| left.name.cmp(&right.name));
    expected.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(inherited.len(), expected.len());
    for (session, (name, pid, process_group, generation)) in inherited.iter().zip(&expected) {
        assert_eq!(
            (
                &session.name,
                session.pid,
                session.process_group,
                session.generation,
            ),
            (name, *pid, *process_group, *generation)
        );
        let lease = client
            .lease(name, *generation)
            .expect("lease inherited session");
        assert_eq!(lease.session.pid, *pid);
        drop(lease);
        client
            .kill(name, *generation)
            .expect("cleanup inherited session");
    }

    candidate_shutdown.store(true, Ordering::Release);
    candidate.join().expect("join candidate vault");
}

#[test]
fn failed_vault_candidate_leaves_old_generation_authoritative() {
    let vault = RunningVault::start(2);
    let client = VaultClient::new(vault.socket_path());
    let session = client
        .create("main", waiting_launch(vault.root()), 80, 24, 1)
        .expect("create session");
    let mut control = UnixStream::connect(vault.socket_path()).expect("connect old vault");
    pty_manager::fd_transfer::send_message(
        &mut control,
        &VaultRequest {
            protocol_version: VAULT_PROTOCOL_VERSION,
            request_id: 41,
            payload: Some(vault_request::Payload::BeginHandover(BeginHandover {
                transfer_socket_path: vault
                    .root()
                    .join("missing-candidate.sock")
                    .to_string_lossy()
                    .into_owned(),
            })),
        },
        None,
    )
    .expect("request failed handover");
    let (response, descriptor) =
        pty_manager::fd_transfer::receive_message::<VaultResponse>(&mut control)
            .expect("receive failed handover");
    assert!(descriptor.is_none());
    assert!(!response.error.is_empty());

    let listed = client.list().expect("old vault resumed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pid, session.session.pid);
    assert!(process_exists(session.session.pid));
    client
        .kill("main", session.session.generation)
        .expect("cleanup old vault session");
}

#[test]
fn candidate_disconnect_after_ready_rolls_back_to_old_vault() {
    let vault = RunningVault::start(2);
    let client = VaultClient::new(vault.socket_path());
    let session = client
        .create("main", waiting_launch(vault.root()), 80, 24, 1)
        .expect("create session");
    let transfer_path = vault.root().join("fake-candidate.sock");
    let transfer_listener = UnixListener::bind(&transfer_path).expect("bind fake candidate");
    let fake_candidate = std::thread::spawn(move || {
        let (mut transfer, _) = transfer_listener.accept().expect("accept transfer");
        let (manifest, listener) =
            pty_manager::fd_transfer::receive_message::<VaultHandoverManifest>(&mut transfer)
                .expect("receive manifest");
        assert!(listener.is_some());
        for _ in 0..manifest.session_count {
            let (_, descriptor) =
                pty_manager::fd_transfer::receive_message::<VaultHandoverDescriptor>(&mut transfer)
                    .expect("receive descriptor");
            assert!(descriptor.is_some());
        }
        pty_manager::fd_transfer::send_message(
            &mut transfer,
            &HandoverPhase {
                phase: handover_phase::Phase::Ready as i32,
            },
            None,
        )
        .expect("send ready");
    });

    let mut control = UnixStream::connect(vault.socket_path()).expect("connect old vault");
    pty_manager::fd_transfer::send_message(
        &mut control,
        &VaultRequest {
            protocol_version: VAULT_PROTOCOL_VERSION,
            request_id: 42,
            payload: Some(vault_request::Payload::BeginHandover(BeginHandover {
                transfer_socket_path: transfer_path.to_string_lossy().into_owned(),
            })),
        },
        None,
    )
    .expect("request handover");
    let (response, descriptor) =
        pty_manager::fd_transfer::receive_message::<VaultResponse>(&mut control)
            .expect("receive rollback response");
    assert!(descriptor.is_none());
    assert!(!response.error.is_empty());
    fake_candidate.join().expect("join fake candidate");

    let listed = client.list().expect("old vault resumed after ready");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pid, session.session.pid);
    assert!(process_exists(session.session.pid));
    client
        .kill("main", session.session.generation)
        .expect("cleanup old vault session");
}

#[test]
fn exact_exit_during_vault_transfer_is_retained_after_rollback() {
    let vault = RunningVault::start(2);
    let client = VaultClient::new(vault.socket_path());
    let session = client
        .create(
            "exiting",
            VaultLaunch::Command {
                cwd: vault.root().to_string_lossy().into_owned(),
                executable: "/bin/sh".to_owned(),
                arguments: vec![
                    "-c".to_owned(),
                    "IFS= read -r line; printf 'reply:%s\\n' \"$line\"; exit 31".to_owned(),
                ],
            },
            80,
            24,
            1,
        )
        .expect("create exiting session");
    let generation = session.session.generation;
    let pid = session.session.pid;
    let mut lease = std::fs::File::from(session.descriptor);

    let transfer_path = vault.root().join("exit-during-transfer.sock");
    let transfer_listener = UnixListener::bind(&transfer_path).expect("bind fake candidate");
    let (descriptors_received_tx, descriptors_received_rx) = mpsc::sync_channel(0);
    let (continue_tx, continue_rx) = mpsc::sync_channel(0);
    let fake_candidate = std::thread::spawn(move || {
        let (mut transfer, _) = transfer_listener.accept().expect("accept transfer");
        let (manifest, listener) =
            pty_manager::fd_transfer::receive_message::<VaultHandoverManifest>(&mut transfer)
                .expect("receive manifest");
        assert!(listener.is_some());
        for _ in 0..manifest.session_count {
            let (_, descriptor) =
                pty_manager::fd_transfer::receive_message::<VaultHandoverDescriptor>(&mut transfer)
                    .expect("receive descriptor");
            assert!(descriptor.is_some());
        }
        descriptors_received_tx
            .send(())
            .expect("signal descriptor receipt");
        continue_rx.recv().expect("continue fake candidate");
        pty_manager::fd_transfer::send_message(
            &mut transfer,
            &HandoverPhase {
                phase: handover_phase::Phase::Ready as i32,
            },
            None,
        )
        .expect("send ready after child exit");
    });

    let control_socket_path = vault.socket_path().to_path_buf();
    let transfer_path_string = transfer_path.to_string_lossy().into_owned();
    let control = std::thread::spawn(move || {
        let mut stream = UnixStream::connect(control_socket_path).expect("connect old vault");
        pty_manager::fd_transfer::send_message(
            &mut stream,
            &VaultRequest {
                protocol_version: VAULT_PROTOCOL_VERSION,
                request_id: 43,
                payload: Some(vault_request::Payload::BeginHandover(BeginHandover {
                    transfer_socket_path: transfer_path_string,
                })),
            },
            None,
        )
        .expect("request handover");
        pty_manager::fd_transfer::receive_message::<VaultResponse>(&mut stream)
            .expect("receive rollback response")
            .0
    });

    descriptors_received_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("candidate did not receive descriptors");
    lease
        .write_all(b"during-transfer\n")
        .expect("write exit input");
    lease.flush().expect("flush exit input");
    assert!(
        read_until(&mut lease, "reply:during-transfer", Duration::from_secs(2))
            .contains("reply:during-transfer")
    );
    for _ in 0..200 {
        if !process_exists(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    continue_tx.send(()).expect("release fake candidate");
    let response = control.join().expect("join handover control");
    assert!(!response.error.is_empty());
    fake_candidate.join().expect("join fake candidate");
    assert_eq!(
        wait_for_exit_status(&client, "exiting", generation, true),
        Some(31)
    );
}

#[test]
fn vault_candidate_rejects_partial_descriptor_delivery() {
    let root = tempdir().expect("vault root");
    let socket_path = root.path().join("pty-vault.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind fake old vault");
    let fake_old = std::thread::spawn(move || {
        let (mut control, _) = listener.accept().expect("accept candidate control");
        let (request, descriptor) =
            pty_manager::fd_transfer::receive_message::<VaultRequest>(&mut control)
                .expect("receive candidate handover request");
        assert!(descriptor.is_none());
        let transfer_socket_path = match request.payload {
            Some(vault_request::Payload::BeginHandover(request)) => request.transfer_socket_path,
            other => panic!("unexpected candidate request: {other:?}"),
        };
        let mut transfer =
            UnixStream::connect(transfer_socket_path).expect("connect candidate transfer socket");
        let session = pty_manager::vault_protocol::generated::Session {
            name: "partial".to_owned(),
            cwd: "/tmp".to_owned(),
            shell: "/bin/sh".to_owned(),
            pid: 1,
            process_group: 1,
            generation: 1,
            started_at_unix_milliseconds: 1,
            columns: 80,
            rows: 24,
            lifetime: 1,
            exited: false,
            exit_status: 0,
        };
        let sessions = vec![session];
        pty_manager::fd_transfer::send_message(
            &mut transfer,
            &VaultHandoverManifest {
                protocol_version: VAULT_PROTOCOL_VERSION,
                vault_generation: 2,
                next_session_generation: 2,
                session_count: 1,
                checksum: test_session_checksum(2, 2, &sessions),
                sessions,
            },
            Some(listener.as_raw_fd()),
        )
        .expect("send partial manifest");
    });

    let result = Vault::handover(VaultOptions {
        socket_path,
        max_sessions: 2,
    });
    assert!(result.is_err());
    fake_old.join().expect("join fake old vault");
}

#[test]
fn zero_session_binary_handover_publishes_candidate_identity() {
    let root = tempdir().expect("vault root");
    let socket_path = root.path().join("pty-vault.sock");
    let identity_path = pty_manager::runtime_identity::identity_path(&socket_path);
    let old_digest = "a".repeat(64);
    let candidate_digest = "b".repeat(64);
    let mut old = spawn_vault_binary(&socket_path, &old_digest, false);
    let old_pid = old.id();
    wait_for_identity(&identity_path, &mut old, &old_digest);

    let mut candidate = spawn_vault_binary(&socket_path, &candidate_digest, true);
    let candidate_pid = candidate.id();
    wait_for_identity(&identity_path, &mut candidate, &candidate_digest);
    wait_for_child_exit(
        &mut old,
        "old vault did not exit after candidate activation",
    );
    println!(
        "{{\"component\":\"vault-authority\",\"oldPid\":{old_pid},\"candidatePid\":{candidate_pid},\"generationBefore\":1,\"generationAfter\":2,\"preserved\":true}}"
    );

    candidate.kill().expect("stop candidate vault");
    candidate.wait().expect("wait candidate vault");
}

fn waiting_launch(root: &Path) -> VaultLaunch {
    VaultLaunch::Command {
        cwd: root.to_string_lossy().into_owned(),
        executable: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), "while :; do sleep 1; done".to_owned()],
    }
}

fn test_session_checksum(
    vault_generation: u64,
    next_session_generation: u64,
    sessions: &[pty_manager::vault_protocol::generated::Session],
) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in vault_generation
        .to_be_bytes()
        .into_iter()
        .chain(next_session_generation.to_be_bytes())
        .chain(sessions.iter().flat_map(Message::encode_to_vec))
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn spawn_vault_binary(socket_path: &Path, digest: &str, handover: bool) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pty-vault"));
    command
        .arg("--socket")
        .arg(socket_path)
        .arg("--runtime-digest")
        .arg(digest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if handover {
        command.arg("--handover");
    }
    command.spawn().expect("spawn pty-vault binary")
}

fn wait_for_identity(path: &Path, child: &mut Child, digest: &str) {
    let pid = child.id();
    let expected = format!("{{\"pid\":{pid},\"digest\":\"{digest}\"}}");
    for _ in 0..400 {
        if let Some(status) = child.try_wait().expect("query runtime status") {
            panic!("runtime {pid} exited before publishing identity: {status}");
        }
        if fs::read_to_string(path)
            .ok()
            .is_some_and(|identity| identity.trim() == expected)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("runtime identity was not published: {}", path.display());
}

fn wait_for_child_exit(child: &mut Child, failure: &str) {
    for _ in 0..400 {
        if child.try_wait().expect("query child exit").is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("{failure}");
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

    fn wait_for_handover(&mut self) {
        for _ in 0..500 {
            if self.shutdown.load(Ordering::Acquire) {
                self.thread
                    .take()
                    .expect("old vault thread")
                    .join()
                    .expect("join old vault after handover");
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.shutdown.store(true, Ordering::Release);
        self.thread
            .take()
            .expect("old vault thread")
            .join()
            .expect("join old vault after failed handover");
        panic!("old vault did not commit handover");
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
