#![cfg(target_os = "macos")]

use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::manager_handover_protocol::generated::{
    ManagerHandoverDescriptor, ManagerHandoverListener, ManagerHandoverManifest,
};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CommandLaunch, CreateOrAttach, Input, Payload,
    RequestTerminalCheckpoint, SessionLifetime, TerminalViewerState, TerminalViewportStatus,
};
use pty_manager::transport::{receive, send, TerminalFramed};
use pty_manager::vault_client::VaultClient;
use pty_manager::vault_protocol::generated::{handover_phase, HandoverPhase};
use tempfile::tempdir;
use tokio::net::UnixStream;

mod support;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_candidate_preserves_checkpoint_revision_pid_and_io() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let options = PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    };
    let old = PtyManager::new(options.clone());
    let old_task = tokio::spawn(async move { old.run().await });
    wait_for_socket(&socket_path).await;

    let mut old_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect old manager");
    send_session(&mut old_client, 1, "tui", root.path(), true).await;
    let before_attached = read_attached(&mut old_client).await;
    let vault = VaultClient::new(socket_path.with_file_name("pty-vault.sock"));
    let before_vault = vault
        .list()
        .expect("list vault before manager handover")
        .into_iter()
        .find(|session| session.name == "tui")
        .expect("vault session before manager handover");
    let _ = read_checkpoint(&mut old_client).await;
    read_until_output(&mut old_client, "TUI:steady").await;
    read_until_output(&mut old_client, "TICK:").await;
    send(
        &mut old_client,
        &protocol::envelope(
            2,
            "tui",
            Payload::RequestTerminalCheckpoint(RequestTerminalCheckpoint {
                last_applied_revision: 0,
            }),
        ),
    )
    .await
    .expect("request pre-handover checkpoint");
    let (before_revision, before_checkpoint) = read_checkpoint(&mut old_client).await;
    assert!(String::from_utf8_lossy(&before_checkpoint).contains("TUI:steady"));

    let candidate = PtyManager::new(options);
    let candidate_task = tokio::spawn(async move { candidate.run_handover().await });
    tokio::time::timeout(Duration::from_secs(5), old_task)
        .await
        .expect("old manager handover timed out")
        .expect("old manager task failed")
        .expect("old manager handover failed");
    drop(old_client);
    wait_for_socket(&socket_path).await;

    let mut new_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect candidate manager");
    send_session(&mut new_client, 3, "tui", root.path(), false).await;
    let after_attached = read_attached(&mut new_client).await;
    let (after_revision, after_checkpoint) = read_checkpoint(&mut new_client).await;
    let after_vault = vault
        .list()
        .expect("list vault after manager handover")
        .into_iter()
        .find(|session| session.name == "tui")
        .expect("vault session after manager handover");
    assert_eq!(after_attached.pid, before_attached.pid);
    assert_eq!(after_vault.pid, before_vault.pid);
    assert_eq!(after_vault.process_group, before_vault.process_group);
    assert_eq!(after_vault.generation, before_vault.generation);
    assert!(after_revision >= before_revision);
    let after_checkpoint = String::from_utf8_lossy(&after_checkpoint);
    assert!(after_checkpoint.contains("TUI:steady"));
    assert!(after_checkpoint.contains("TICK:"));

    send(
        &mut new_client,
        &protocol::envelope(
            4,
            "tui",
            Payload::TerminalViewerState(TerminalViewerState {
                sequence: 1,
                active: true,
                claim: true,
                columns: 100,
                rows: 40,
            }),
        ),
    )
    .await
    .expect("claim and resize after handover");
    let viewport = read_owner_viewport(&mut new_client).await;
    assert_eq!(viewport.owner_client_id, after_attached.client_id);
    assert_eq!(viewport.source_columns, 100);
    assert_eq!(viewport.source_rows, 40);
    let resized = vault
        .list()
        .expect("list resized vault session")
        .into_iter()
        .find(|session| session.name == "tui")
        .expect("resized vault session");
    assert_eq!((resized.columns, resized.rows), (100, 40));

    send(
        &mut new_client,
        &protocol::envelope(
            5,
            "tui",
            Payload::Input(Input {
                data: b"after-handover\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after handover");
    read_until_output(&mut new_client, "input:after-handover").await;
    send(
        &mut new_client,
        &protocol::envelope(
            6,
            "tui",
            Payload::Input(Input {
                data: b"quit\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("quit after handover");
    assert_eq!(read_exit(&mut new_client).await, 17);
    println!(
        "{{\"component\":\"manager\",\"pid\":{},\"managerGenerationBefore\":1,\"managerGenerationAfter\":2,\"revisionBefore\":{},\"revisionAfter\":{},\"marker\":\"TUI:steady\",\"continuouslyChangingTUI\":true,\"exitStatus\":17,\"preserved\":true}}",
        before_attached.pid,
        before_revision,
        after_revision
    );

    candidate_task.abort();
    let _ = candidate_task.await;
    support::close_all_vault_sessions(&socket_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_candidate_preserves_busy_ordinary_shell_identity_and_exit() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let options = PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    };
    let old = PtyManager::new(options.clone());
    let old_task = tokio::spawn(async move { old.run().await });
    wait_for_socket(&socket_path).await;

    let mut old_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect old manager");
    send_ordinary_shell_session(&mut old_client, 1, "shell", root.path(), true).await;
    let before_attached = read_attached(&mut old_client).await;
    let _ = read_checkpoint(&mut old_client).await;
    read_until_output(&mut old_client, "shell-ready").await;
    let vault = VaultClient::new(socket_path.with_file_name("pty-vault.sock"));
    let before_vault = vault
        .list()
        .expect("list shell before handover")
        .into_iter()
        .find(|session| session.name == "shell")
        .expect("shell before handover");

    let candidate = PtyManager::new(options);
    let candidate_task = tokio::spawn(async move { candidate.run_handover().await });
    tokio::time::timeout(Duration::from_secs(5), old_task)
        .await
        .expect("old manager handover timed out")
        .expect("old manager task failed")
        .expect("old manager handover failed");
    drop(old_client);
    wait_for_socket(&socket_path).await;

    let mut new_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect candidate manager");
    send_ordinary_shell_session(&mut new_client, 2, "shell", root.path(), false).await;
    let after_attached = read_attached(&mut new_client).await;
    let _ = read_checkpoint(&mut new_client).await;
    let after_vault = vault
        .list()
        .expect("list shell after handover")
        .into_iter()
        .find(|session| session.name == "shell")
        .expect("shell after handover");
    assert_eq!(after_attached.pid, before_attached.pid);
    assert_eq!(after_vault.pid, before_vault.pid);
    assert_eq!(after_vault.process_group, before_vault.process_group);
    assert_eq!(after_vault.generation, before_vault.generation);

    send(
        &mut new_client,
        &protocol::envelope(
            3,
            "shell",
            Payload::Input(Input {
                data: b"after-handover\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send shell input after handover");
    read_until_output(&mut new_client, "shell:after-handover").await;
    send(
        &mut new_client,
        &protocol::envelope(
            4,
            "shell",
            Payload::Input(Input {
                data: b"quit\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("quit shell after handover");
    assert_eq!(read_exit(&mut new_client).await, 19);

    candidate_task.abort();
    let _ = candidate_task.await;
    support::close_all_vault_sessions(&socket_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_handover_does_not_reap_transferred_leased_session() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let options = PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_millis(100),
    };
    let old = PtyManager::new(options.clone());
    let old_task = tokio::spawn(async move { old.run().await });
    wait_for_socket(&socket_path).await;

    let mut old_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect old manager");
    send_session_with_lifetime(
        &mut old_client,
        1,
        "leased",
        root.path(),
        true,
        SessionLifetime::Leased,
    )
    .await;
    let before = read_attached(&mut old_client).await;
    let _ = read_checkpoint(&mut old_client).await;
    read_until_output(&mut old_client, "TUI:steady").await;

    let candidate = PtyManager::new(options);
    let candidate_task = tokio::spawn(async move { candidate.run_handover().await });
    tokio::time::timeout(Duration::from_secs(5), old_task)
        .await
        .expect("old manager handover timed out")
        .expect("old manager task failed")
        .expect("old manager handover failed");
    drop(old_client);

    tokio::time::sleep(Duration::from_millis(250)).await;
    let vault = VaultClient::new(socket_path.with_file_name("pty-vault.sock"));
    let preserved = vault
        .list()
        .expect("list vault after leased grace")
        .into_iter()
        .find(|session| session.name == "leased")
        .expect("handover must not reap transferred leased session");
    assert_eq!(preserved.pid, before.pid);
    assert!(process_exists(before.pid));

    let mut new_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect candidate manager");
    send_session_with_lifetime(
        &mut new_client,
        2,
        "leased",
        root.path(),
        false,
        SessionLifetime::Leased,
    )
    .await;
    assert_eq!(read_attached(&mut new_client).await.pid, before.pid);
    let _ = read_checkpoint(&mut new_client).await;
    send(
        &mut new_client,
        &protocol::envelope(
            3,
            "leased",
            Payload::Input(Input {
                data: b"quit\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("quit preserved leased session");
    assert_eq!(read_exit(&mut new_client).await, 17);

    candidate_task.abort();
    let _ = candidate_task.await;
    support::close_all_vault_sessions(&socket_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_manager_candidate_resumes_old_reader_and_client() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let options = PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    };
    let manager = PtyManager::new(options);
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;
    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect old manager");
    send_session(&mut client, 1, "rollback", root.path(), true).await;
    let attached = read_attached(&mut client).await;
    let _ = read_checkpoint(&mut client).await;
    read_until_output(&mut client, "TUI:steady").await;

    let handover_path = socket_path.with_file_name("terminal.sock.handover");
    std::thread::spawn(move || {
        let mut failed = StdUnixStream::connect(handover_path).expect("connect failed candidate");
        receive_fake_manager_snapshot(&mut failed);
        pty_manager::fd_transfer::send_message(
            &mut failed,
            &HandoverPhase {
                phase: handover_phase::Phase::Ready as i32,
            },
            None,
        )
        .expect("send manager ready");
    })
    .join()
    .expect("join failed manager candidate");
    tokio::time::sleep(Duration::from_millis(100)).await;

    send(
        &mut client,
        &protocol::envelope(
            2,
            "rollback",
            Payload::Input(Input {
                data: b"rollback-ok\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after rollback");
    read_until_output(&mut client, "input:rollback-ok").await;
    assert!(process_exists(attached.pid));

    let handover_path = socket_path.with_file_name("terminal.sock.handover");
    std::thread::spawn(move || {
        let mut failed = StdUnixStream::connect(handover_path).expect("connect failed candidate");
        receive_fake_manager_snapshot(&mut failed);
    })
    .join()
    .expect("join pre-ready failed manager candidate");
    tokio::time::sleep(Duration::from_millis(100)).await;
    send(
        &mut client,
        &protocol::envelope(
            3,
            "rollback",
            Payload::Input(Input {
                data: b"pre-ready-rollback-ok\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after pre-ready rollback");
    read_until_output(&mut client, "input:pre-ready-rollback-ok").await;
    assert!(process_exists(attached.pid));

    manager_task.abort();
    let _ = manager_task.await;
    support::close_all_vault_sessions(&socket_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_manager_recovers_live_vault_session_after_crash() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let options = PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    };
    let old = PtyManager::new(options.clone());
    let (old_shutdown_tx, old_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let old_task = tokio::spawn(async move {
        old.run_until_shutdown(async move {
            let _ = old_shutdown_rx.await;
        })
        .await
    });
    wait_for_socket(&socket_path).await;
    let mut old_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect original manager");
    send_session(&mut old_client, 1, "recovery", root.path(), true).await;
    let before = read_attached(&mut old_client).await;
    let _ = read_checkpoint(&mut old_client).await;
    read_until_output(&mut old_client, "TUI:steady").await;

    old_shutdown_tx.send(()).expect("stop old manager");
    tokio::time::timeout(Duration::from_secs(2), old_task)
        .await
        .expect("old manager stop timed out")
        .expect("old manager task failed")
        .expect("old manager stop failed");
    assert!(process_exists(before.pid));
    drop(old_client);

    let replacement = PtyManager::new(options);
    let (replacement_shutdown_tx, replacement_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let replacement_task = tokio::spawn(async move {
        replacement
            .run_until_shutdown(async move {
                let _ = replacement_shutdown_rx.await;
            })
            .await
    });
    wait_for_socket(&socket_path).await;
    let mut new_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect replacement manager");
    send_session(&mut new_client, 2, "recovery", root.path(), false).await;
    let after = read_attached(&mut new_client).await;
    let _ = read_checkpoint(&mut new_client).await;
    assert_eq!(after.pid, before.pid);
    send(
        &mut new_client,
        &protocol::envelope(
            3,
            "recovery",
            Payload::Input(Input {
                data: b"recovered\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after recovery");
    read_until_output(&mut new_client, "input:recovered").await;

    replacement_shutdown_tx
        .send(())
        .expect("stop replacement manager");
    tokio::time::timeout(Duration::from_secs(2), replacement_task)
        .await
        .expect("replacement stop timed out")
        .expect("replacement task failed")
        .expect("replacement stop failed");
    assert!(process_exists(before.pid));
    support::close_all_vault_sessions(&socket_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_manager_reseeds_replacement_vault_from_its_lease() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    support::ensure_vault_for_manager(&socket_path);
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;
    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect manager");
    send_session(&mut client, 1, "vault-reseed", root.path(), true).await;
    let attached = read_attached(&mut client).await;
    let _ = read_checkpoint(&mut client).await;
    read_until_output(&mut client, "TUI:steady").await;

    support::restart_vault_for_manager(&socket_path);
    let vault = VaultClient::new(socket_path.with_file_name("pty-vault.sock"));
    let mut imported = None;
    for _ in 0..100 {
        imported = vault.list().ok().and_then(|sessions| {
            sessions
                .into_iter()
                .find(|session| session.name == "vault-reseed")
        });
        if imported.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let imported = imported.expect("manager did not reseed replacement vault");
    assert_eq!(imported.pid, attached.pid);

    send(
        &mut client,
        &protocol::envelope(
            2,
            "vault-reseed",
            Payload::Input(Input {
                data: b"after-vault-reseed\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after vault reseed");
    read_until_output(&mut client, "input:after-vault-reseed").await;
    send(
        &mut client,
        &protocol::envelope(
            3,
            "vault-reseed",
            Payload::Input(Input {
                data: b"quit\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("quit after vault reseed");
    assert_eq!(read_exit(&mut client).await, 17);

    manager_task.abort();
    let _ = manager_task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_session_manager_binary_handover_publishes_candidate_identity() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    let vault_socket_path = root.path().join("pty-vault.sock");
    let identity_path = pty_manager::runtime_identity::identity_path(&socket_path);
    let mut vault = spawn_binary(
        env!("CARGO_BIN_EXE_pty-vault"),
        &vault_socket_path,
        None,
        false,
    );
    wait_for_std_socket(&vault_socket_path);

    let old_digest = "c".repeat(64);
    let candidate_digest = "d".repeat(64);
    let mut old = spawn_binary(
        env!("CARGO_BIN_EXE_pty-manager"),
        &socket_path,
        Some(&old_digest),
        false,
    );
    let old_pid = old.id();
    wait_for_identity(&identity_path, &mut old, &old_digest);

    let mut candidate = spawn_binary(
        env!("CARGO_BIN_EXE_pty-manager"),
        &socket_path,
        Some(&candidate_digest),
        true,
    );
    let candidate_pid = candidate.id();
    wait_for_identity(&identity_path, &mut candidate, &candidate_digest);
    wait_for_child_exit(&mut old, "old manager did not exit after activation");
    println!(
        "{{\"component\":\"manager-authority\",\"oldPid\":{old_pid},\"candidatePid\":{candidate_pid},\"generationBefore\":1,\"generationAfter\":2,\"preserved\":true}}"
    );

    candidate.kill().expect("stop candidate manager");
    candidate.wait().expect("wait candidate manager");
    vault.kill().expect("stop test vault");
    vault.wait().expect("wait test vault");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sequential_live_update_gate_emits_session_evidence() {
    let root = tempdir().expect("tempdir");
    let socket_path = root.path().join("terminal.sock");
    let vault_socket_path = root.path().join("pty-vault.sock");
    let manager_identity_path = pty_manager::runtime_identity::identity_path(&socket_path);
    let vault_identity_path = pty_manager::runtime_identity::identity_path(&vault_socket_path);
    let old_manager_digest = "1".repeat(64);
    let new_manager_digest = "2".repeat(64);
    let old_vault_digest = "3".repeat(64);
    let new_vault_digest = "4".repeat(64);

    let mut old_vault = spawn_binary(
        env!("CARGO_BIN_EXE_pty-vault"),
        &vault_socket_path,
        Some(&old_vault_digest),
        false,
    );
    let old_vault_pid = old_vault.id();
    wait_for_identity(&vault_identity_path, &mut old_vault, &old_vault_digest);
    let mut old_manager = spawn_binary(
        env!("CARGO_BIN_EXE_pty-manager"),
        &socket_path,
        Some(&old_manager_digest),
        false,
    );
    let old_manager_pid = old_manager.id();
    wait_for_identity(
        &manager_identity_path,
        &mut old_manager,
        &old_manager_digest,
    );

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect initial host client");
    send_session(&mut client, 1, "live-update", root.path(), true).await;
    let initial_attached = read_attached(&mut client).await;
    let _ = read_checkpoint(&mut client).await;
    read_until_output(&mut client, "TUI:steady").await;
    read_until_output(&mut client, "TICK:").await;
    send(
        &mut client,
        &protocol::envelope(
            2,
            "live-update",
            Payload::RequestTerminalCheckpoint(RequestTerminalCheckpoint {
                last_applied_revision: 0,
            }),
        ),
    )
    .await
    .expect("request initial live-update checkpoint");
    let (initial_revision, initial_checkpoint) = read_checkpoint(&mut client).await;
    assert!(String::from_utf8_lossy(&initial_checkpoint).contains("TUI:steady"));
    let vault_client = VaultClient::new(vault_socket_path.clone());
    let initial_session = vault_client
        .list()
        .expect("list initial vault session")
        .into_iter()
        .find(|session| session.name == "live-update")
        .expect("initial live-update session");

    // A host-only update reconnects its manager client. The runtime authority
    // and session must remain unchanged because neither Rust digest changed.
    drop(client);
    let mut host_reconnected = pty_manager::client::connect(&socket_path)
        .await
        .expect("reconnect host client");
    send_session(&mut host_reconnected, 2, "live-update", root.path(), false).await;
    let host_attached = read_attached(&mut host_reconnected).await;
    let (host_revision, host_checkpoint) = read_checkpoint(&mut host_reconnected).await;
    assert_eq!(host_attached.pid, initial_attached.pid);
    assert!(host_revision >= initial_revision);
    assert!(String::from_utf8_lossy(&host_checkpoint).contains("TUI:steady"));

    let mut new_manager = spawn_binary(
        env!("CARGO_BIN_EXE_pty-manager"),
        &socket_path,
        Some(&new_manager_digest),
        true,
    );
    let new_manager_pid = new_manager.id();
    wait_for_identity(
        &manager_identity_path,
        &mut new_manager,
        &new_manager_digest,
    );
    wait_for_child_exit(
        &mut old_manager,
        "old manager did not exit after live-update handover",
    );
    drop(host_reconnected);

    let mut manager_reconnected = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect candidate manager");
    send_session(
        &mut manager_reconnected,
        3,
        "live-update",
        root.path(),
        false,
    )
    .await;
    let manager_attached = read_attached(&mut manager_reconnected).await;
    let (manager_revision, manager_checkpoint) = read_checkpoint(&mut manager_reconnected).await;
    assert_eq!(manager_attached.pid, initial_attached.pid);
    assert!(manager_revision >= host_revision);
    assert!(String::from_utf8_lossy(&manager_checkpoint).contains("TUI:steady"));

    let mut new_vault = spawn_binary(
        env!("CARGO_BIN_EXE_pty-vault"),
        &vault_socket_path,
        Some(&new_vault_digest),
        true,
    );
    let new_vault_pid = new_vault.id();
    wait_for_identity(&vault_identity_path, &mut new_vault, &new_vault_digest);
    wait_for_child_exit(
        &mut old_vault,
        "old vault did not exit after live-update handover",
    );
    let after_vault = vault_client
        .list()
        .expect("list session after vault handover")
        .into_iter()
        .find(|session| session.name == "live-update")
        .expect("session after vault handover");
    assert_eq!(after_vault.pid, initial_session.pid);
    assert_eq!(after_vault.process_group, initial_session.process_group);
    assert_eq!(after_vault.generation, initial_session.generation);

    send(
        &mut manager_reconnected,
        &protocol::envelope(
            4,
            "live-update",
            Payload::Input(Input {
                data: b"after-all-updates\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input after all updates");
    read_until_output(&mut manager_reconnected, "input:after-all-updates").await;
    send(
        &mut manager_reconnected,
        &protocol::envelope(
            5,
            "live-update",
            Payload::Input(Input {
                data: b"quit\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("quit after all updates");
    let exit_status = read_exit(&mut manager_reconnected).await;
    assert_eq!(exit_status, 17);

    println!(
        concat!(
            "{{\"gate\":\"pty-live-update-verify\",",
            "\"host\":{{\"managerPidBefore\":{},\"managerPidAfter\":{},",
            "\"vaultPidBefore\":{},\"vaultPidAfter\":{},\"preserved\":true}},",
            "\"manager\":{{\"pidBefore\":{},\"pidAfter\":{},",
            "\"generationBefore\":1,\"generationAfter\":2}},",
            "\"vault\":{{\"pidBefore\":{},\"pidAfter\":{},",
            "\"generationBefore\":1,\"generationAfter\":2}},",
            "\"session\":{{\"pid\":{},\"processGroup\":{},\"generation\":{},",
            "\"revisionBefore\":{},\"revisionAfterHost\":{},\"revisionAfterManager\":{},",
            "\"marker\":\"TUI:steady\",\"exitStatus\":{}}},\"status\":\"passed\"}}"
        ),
        old_manager_pid,
        old_manager_pid,
        old_vault_pid,
        old_vault_pid,
        old_manager_pid,
        new_manager_pid,
        old_vault_pid,
        new_vault_pid,
        initial_session.pid,
        initial_session.process_group,
        initial_session.generation,
        initial_revision,
        host_revision,
        manager_revision,
        exit_status
    );

    new_manager.kill().expect("stop candidate manager");
    new_manager.wait().expect("wait candidate manager");
    new_vault.kill().expect("stop candidate vault");
    new_vault.wait().expect("wait candidate vault");
}

async fn send_session(
    framed: &mut TerminalFramed,
    request_id: u64,
    session_name: &str,
    cwd: &Path,
    create_if_missing: bool,
) {
    send_session_with_lifetime(
        framed,
        request_id,
        session_name,
        cwd,
        create_if_missing,
        SessionLifetime::Persistent,
    )
    .await;
}

async fn send_session_with_lifetime(
    framed: &mut TerminalFramed,
    request_id: u64,
    session_name: &str,
    cwd: &Path,
    create_if_missing: bool,
    lifetime: SessionLifetime,
) {
    send(
        framed,
        &protocol::envelope(
            request_id,
            session_name,
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: cwd.to_string_lossy().into_owned(),
                    executable: "/bin/sh".to_owned(),
                    arguments: vec![
                        "-c".to_owned(),
                        "printf '\\033[2J\\033[HTUI:steady\\n'; tick=0; while :; do printf '\\033[3;1HTICK:%06d' \"$tick\"; tick=$((tick + 1)); sleep 0.02; done & ticker=$!; trap 'kill \"$ticker\" 2>/dev/null; wait \"$ticker\" 2>/dev/null' EXIT; while IFS= read -r line; do printf '\\033[2;1Hinput:%s\\n' \"$line\"; [ \"$line\" = quit ] && exit 17; done"
                            .to_owned(),
                    ],
                })),
                lifetime: lifetime as i32,
                columns: 80,
                rows: 24,
                create_if_missing,
                client_title: "handover test".to_owned(),
            }),
        ),
    )
    .await
    .expect("send create or attach");
}

async fn send_ordinary_shell_session(
    framed: &mut TerminalFramed,
    request_id: u64,
    session_name: &str,
    cwd: &Path,
    create_if_missing: bool,
) {
    send(
        framed,
        &protocol::envelope(
            request_id,
            session_name,
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: cwd.to_string_lossy().into_owned(),
                    executable: "/bin/sh".to_owned(),
                    arguments: vec![
                        "-c".to_owned(),
                        "printf 'shell-ready\\n'; while IFS= read -r line; do printf 'shell:%s\\n' \"$line\"; [ \"$line\" = quit ] && exit 19; done"
                            .to_owned(),
                    ],
                })),
                lifetime: SessionLifetime::Persistent as i32,
                columns: 80,
                rows: 24,
                create_if_missing,
                client_title: "ordinary shell handover test".to_owned(),
            }),
        ),
    )
    .await
    .expect("send shell create or attach");
}

async fn read_attached(framed: &mut TerminalFramed) -> Attached {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Attached(attached) => return attached,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("manager error: {}", error.message),
            other => panic!("unexpected payload before attach: {other:?}"),
        }
    }
}

async fn read_checkpoint(framed: &mut TerminalFramed) -> (u64, Vec<u8>) {
    let mut checkpoint_id = None;
    let mut revision = 0;
    let mut expected_chunks = 0;
    let mut chunks = 0;
    let mut bytes = Vec::new();
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::TerminalCheckpointBegin(begin) => {
                checkpoint_id = Some(begin.checkpoint_id);
                revision = begin.revision;
                expected_chunks = begin.chunk_count;
            }
            Payload::TerminalCheckpointChunk(chunk) => {
                assert_eq!(Some(chunk.checkpoint_id), checkpoint_id);
                assert_eq!(chunk.index, chunks);
                chunks += 1;
                bytes.extend(chunk.data);
            }
            Payload::TerminalCheckpointEnd(end) => {
                assert_eq!(Some(end.checkpoint_id), checkpoint_id);
                assert_eq!(end.revision, revision);
                assert_eq!(chunks, expected_chunks);
                return (revision, bytes);
            }
            Payload::Output(_) | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("manager error: {}", error.message),
            other => panic!("unexpected payload before checkpoint: {other:?}"),
        }
    }
}

async fn read_until_output(framed: &mut TerminalFramed, needle: &str) {
    let mut output = Vec::new();
    for _ in 0..100 {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Output(frame) => {
                output.extend(frame.data);
                if String::from_utf8_lossy(&output).contains(needle) {
                    return;
                }
            }
            Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("manager error: {}", error.message),
            other => panic!("unexpected payload while reading output: {other:?}"),
        }
    }
    panic!(
        "output did not contain {needle:?}: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn read_exit(framed: &mut TerminalFramed) -> i32 {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionExited(exited) => return exited.status,
            Payload::Output(_) | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("manager error: {}", error.message),
            other => panic!("unexpected payload before exit: {other:?}"),
        }
    }
}

async fn read_owner_viewport(framed: &mut TerminalFramed) -> TerminalViewportStatus {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::TerminalViewportStatus(status) if status.is_owner => return status,
            Payload::TerminalViewportStatus(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::Output(_) => {}
            Payload::Error(error) => panic!("manager error: {}", error.message),
            other => panic!("unexpected payload before owner viewport: {other:?}"),
        }
    }
}

async fn wait_for_socket(socket_path: &Path) {
    for _ in 0..200 {
        if UnixStream::connect(socket_path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("manager socket did not become ready");
}

fn process_exists(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn receive_fake_manager_snapshot(stream: &mut StdUnixStream) {
    let (manifest, public_listener) =
        pty_manager::fd_transfer::receive_message::<ManagerHandoverManifest>(stream)
            .expect("receive manager manifest");
    assert!(public_listener.is_some());
    let (_, handover_listener) =
        pty_manager::fd_transfer::receive_message::<ManagerHandoverListener>(stream)
            .expect("receive manager listener");
    assert!(handover_listener.is_some());
    for _ in 0..manifest.session_count {
        let (_, descriptor) =
            pty_manager::fd_transfer::receive_message::<ManagerHandoverDescriptor>(stream)
                .expect("receive manager PTY lease");
        assert!(descriptor.is_some());
    }
}

fn spawn_binary(
    executable: &str,
    socket_path: &Path,
    digest: Option<&str>,
    handover: bool,
) -> Child {
    let mut command = Command::new(executable);
    command
        .arg("--socket")
        .arg(socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(digest) = digest {
        command.arg("--runtime-digest").arg(digest);
    }
    if handover {
        command.arg("--handover");
    }
    command.spawn().expect("spawn PTY runtime binary")
}

fn wait_for_std_socket(path: &Path) {
    for _ in 0..400 {
        if StdUnixStream::connect(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("runtime socket did not become ready: {}", path.display());
}

fn wait_for_identity(path: &Path, child: &mut Child, digest: &str) {
    let pid = child.id();
    let expected = format!("{{\"pid\":{pid},\"digest\":\"{digest}\"}}");
    for _ in 0..400 {
        if let Some(status) = child.try_wait().expect("query runtime status") {
            panic!("runtime {pid} exited before publishing identity: {status}");
        }
        if std::fs::read_to_string(path)
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
