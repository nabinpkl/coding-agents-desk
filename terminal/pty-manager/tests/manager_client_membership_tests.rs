use std::path::Path;
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CreateOrAttach, Detach, Input, KillSession, Payload,
    SessionExited, ShellLaunch,
};
use pty_manager::transport::{receive, send};
use tempfile::tempdir;
use tokio::net::UnixStream;

mod support;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_final_detach_survives_grace_until_killed() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut first_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect first client");
    send(
        &mut first_client,
        &protocol::envelope(
            1,
            "0",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "first".to_owned(),
            }),
        ),
    )
    .await
    .expect("create session");
    let first_attached = read_attached(&mut first_client).await;

    send(
        &mut first_client,
        &protocol::envelope(
            2,
            "0",
            Payload::Input(Input {
                data: b"printf 'pty-probe\\n'\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input");
    read_until_output(&mut first_client, "pty-probe").await;

    send(
        &mut first_client,
        &protocol::envelope(3, "0", Payload::Detach(Detach {})),
    )
    .await
    .expect("detach first client");
    drop(first_client);

    tokio::time::sleep(Duration::from_millis(80)).await;

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list sessions after detach");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "0");
    assert!(sessions[0].clients.is_empty());

    let mut second_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect second client");
    send(
        &mut second_client,
        &protocol::envelope(
            4,
            "0",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "second".to_owned(),
            }),
        ),
    )
    .await
    .expect("reattach session");
    let second_attached = read_attached(&mut second_client).await;
    assert_eq!(second_attached.pid, first_attached.pid);

    send(
        &mut second_client,
        &protocol::envelope(5, "0", Payload::KillSession(KillSession {})),
    )
    .await
    .expect("kill session");
    let exited = read_session_exited(&mut second_client).await;
    assert_eq!(exited.status, 129);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_subscriber_receives_snapshots_without_attaching() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut subscriber = pty_manager::client::subscribe_sessions(&socket_path)
        .await
        .expect("subscribe sessions");
    let initial = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("initial snapshot");
    assert!(initial.is_empty());

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    send_create(&mut client, 1, "main", tempdir.path()).await;
    let attached = read_attached(&mut client).await;
    assert!(attached.pid > 0);

    let created = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("created snapshot");
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].name, "main");
    assert_eq!(created[0].clients.len(), 1);
    assert_eq!(created[0].clients[0].title, "client main");

    send(
        &mut client,
        &protocol::envelope(2, "main", Payload::Detach(Detach {})),
    )
    .await
    .expect("detach client");
    drop(client);

    let detached = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("detached snapshot");
    assert_eq!(detached.len(), 1);
    assert_eq!(detached[0].name, "main");
    assert!(detached[0].clients.is_empty());

    let status = pty_manager::client::kill_session(&socket_path, "main")
        .await
        .expect("kill session");
    assert_eq!(status, 129);

    let killed = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("killed snapshot");
    assert!(killed.is_empty());

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_session_subscriber_does_not_change_attached_clients() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    send_create(&mut client, 1, "main", tempdir.path()).await;
    read_attached(&mut client).await;

    let mut subscriber = pty_manager::client::subscribe_sessions(&socket_path)
        .await
        .expect("subscribe sessions");
    let snapshot = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("initial snapshot");
    assert_eq!(snapshot[0].clients.len(), 1);
    drop(subscriber);

    tokio::time::sleep(Duration::from_millis(20)).await;
    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "main");
    assert_eq!(sessions[0].clients.len(), 1);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_client_detaches_only_target_and_keeps_session_running() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut first_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect first client");
    send_create(&mut first_client, 1, "main", tempdir.path()).await;
    let first_attached = read_attached(&mut first_client).await;

    let mut second_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect second client");
    send(
        &mut second_client,
        &protocol::envelope(
            2,
            "main",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "second".to_owned(),
            }),
        ),
    )
    .await
    .expect("attach second client");
    let _second_attached = read_attached(&mut second_client).await;

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list clients");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].clients.len(), 2);
    let first_client_id = sessions[0].clients[0].id;
    assert_eq!(first_client_id, first_attached.client_id);

    let closed = pty_manager::client::close_client(&socket_path, "main", first_client_id)
        .await
        .expect("close first client");
    assert_eq!(closed, first_client_id);
    assert_eq!(
        read_client_detached(&mut first_client).await,
        first_client_id
    );

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list remaining clients");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].clients.len(), 1);
    assert_eq!(sessions[0].clients[0].title, "second");

    send(
        &mut second_client,
        &protocol::envelope(
            3,
            "main",
            Payload::Input(Input {
                data: b"printf 'still-running\\n'\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send input to remaining client");
    read_until_output(&mut second_client, "still-running").await;

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_session_detaches_attached_clients() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut terminal_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect terminal client");
    send_create(&mut terminal_client, 1, "main", tempdir.path()).await;
    let terminal_attached = read_attached(&mut terminal_client).await;

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list clients");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].clients.len(), 1);
    let terminal_client_id = sessions[0].clients[0].id;
    assert_eq!(terminal_client_id, terminal_attached.client_id);

    let status = pty_manager::client::kill_session(&socket_path, "main")
        .await
        .expect("kill session");
    assert_eq!(status, 129);

    let exited = read_session_exited(&mut terminal_client).await;
    assert_eq!(exited.status, 129);
    assert_eq!(
        read_client_detached(&mut terminal_client).await,
        terminal_client_id
    );
    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list after kill");
    assert!(sessions.is_empty());

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_without_create_fails_for_missing_session() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    send(
        &mut client,
        &protocol::envelope(
            1,
            "missing",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 80,
                rows: 24,
                create_if_missing: false,
                client_title: "attach-only".to_owned(),
            }),
        ),
    )
    .await
    .expect("send attach-only request");

    let envelope = receive(&mut client).await.expect("receive").expect("frame");
    match protocol::payload(envelope).expect("payload") {
        Payload::Error(error) => assert!(error.message.contains("session not found: missing")),
        other => panic!("expected error, got {other:?}"),
    }

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_client_replays_output_produced_with_no_clients_then_receives_consecutive_live_tail() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut first = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect first client");
    send_create(&mut first, 1, "replay", tempdir.path()).await;
    read_attached(&mut first).await;
    send(
        &mut first,
        &protocol::envelope(
            2,
            "replay",
            Payload::Input(Input {
                data: b"(sleep 0.05; printf 'offline-marker\\n') &\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("schedule output");
    send(
        &mut first,
        &protocol::envelope(3, "replay", Payload::Detach(Detach {})),
    )
    .await
    .expect("detach first client");
    drop(first);
    tokio::time::sleep(Duration::from_millis(120)).await;

    let mut late = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect late client");
    send(
        &mut late,
        &protocol::envelope(
            4,
            "replay",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 160,
                rows: 60,
                create_if_missing: false,
                client_title: "late".to_owned(),
            }),
        ),
    )
    .await
    .expect("attach late client");
    let attached = read_attached(&mut late).await;
    assert_eq!((attached.columns, attached.rows), (80, 24));
    let (checkpoint_revision, checkpoint) = read_checkpoint(&mut late).await;
    assert!(
        String::from_utf8_lossy(&checkpoint).contains("offline-marker"),
        "late checkpoint omitted offline output"
    );

    send(
        &mut late,
        &protocol::envelope(
            5,
            "replay",
            Payload::Input(Input {
                data: b"printf 'live-marker\\n'\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send live output");
    let (claimed_revision, _) = read_checkpoint_with_dimensions(&mut late, 160, 60).await;
    assert!(claimed_revision > checkpoint_revision);
    let first_live_revision = read_output_revisions(&mut late, "live-marker").await;
    assert!(first_live_revision > claimed_revision);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_viewport_resize_advances_once_and_checkpoints_every_client_at_the_shared_grid() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut first = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect first client");
    send_create(&mut first, 1, "resize-shared", tempdir.path()).await;
    read_attached(&mut first).await;
    let (initial_revision, _) = read_checkpoint(&mut first).await;

    let mut second = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect second client");
    send_create(&mut second, 2, "resize-shared", tempdir.path()).await;
    let second_attached = read_attached(&mut second).await;
    assert_eq!((second_attached.columns, second_attached.rows), (80, 24));
    read_checkpoint(&mut second).await;

    send(
        &mut first,
        &protocol::envelope(
            3,
            "resize-shared",
            Payload::TerminalViewerState(protocol::TerminalViewerState {
                sequence: 1,
                active: true,
                claim: true,
                columns: 120,
                rows: 35,
            }),
        ),
    )
    .await
    .expect("resize shared session");

    let (first_revision, _) = read_checkpoint_with_dimensions(&mut first, 120, 35).await;
    let (second_revision, _) = read_checkpoint_with_dimensions(&mut second, 120, 35).await;
    assert!(first_revision > initial_revision);
    assert_eq!(second_revision, first_revision);
    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list sessions");
    assert_eq!((sessions[0].columns, sessions[0].rows), (120, 35));
    assert!(sessions[0].revision >= first_revision);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn viewer_claims_passive_reports_equal_size_transfer_and_fallback_are_serialized() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut first = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect first client");
    send_create(&mut first, 1, "ownership", tempdir.path()).await;
    let first_attached = read_attached(&mut first).await;
    let (initial_revision, _) = read_checkpoint(&mut first).await;
    let initial_status = read_viewport_status(&mut first).await;
    assert_eq!(initial_status.owner_client_id, 0);

    let mut second = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect second client");
    send_create(&mut second, 2, "ownership", tempdir.path()).await;
    let second_attached = read_attached(&mut second).await;
    read_checkpoint(&mut second).await;
    read_viewport_status(&mut second).await;

    send_viewer_state(&mut first, 3, "ownership", 1, true, false, 100, 30).await;
    let passive = read_viewport_status(&mut first).await;
    assert_eq!(passive.owner_client_id, 0);
    assert_eq!((passive.view_columns, passive.view_rows), (100, 30));
    assert!(passive.source_revision >= initial_revision);

    send_viewer_state(&mut first, 4, "ownership", 2, true, true, 100, 30).await;
    let (first_owner_revision, _) = read_checkpoint_with_dimensions(&mut first, 100, 30).await;
    read_checkpoint_with_dimensions(&mut second, 100, 30).await;
    let first_owner = read_viewport_status(&mut first).await;
    let first_owner_for_second = read_viewport_status(&mut second).await;
    assert_eq!(first_owner.owner_client_id, first_attached.client_id);
    assert_eq!(
        first_owner_for_second.owner_client_id,
        first_attached.client_id
    );
    assert!(first_owner.is_owner);
    assert!(first_owner_revision > initial_revision);

    send_viewer_state(&mut second, 5, "ownership", 1, true, false, 60, 20).await;
    let second_passive = read_viewport_status(&mut second).await;
    assert_eq!(second_passive.owner_client_id, first_attached.client_id);
    assert!(second_passive.source_revision >= first_owner_revision);

    send_viewer_state(&mut second, 6, "ownership", 2, true, true, 60, 20).await;
    read_checkpoint_with_dimensions(&mut first, 60, 20).await;
    let (second_owner_revision, _) = read_checkpoint_with_dimensions(&mut second, 60, 20).await;
    let second_owner_for_first = read_viewport_status(&mut first).await;
    let second_owner = read_viewport_status(&mut second).await;
    assert_eq!(
        second_owner_for_first.owner_client_id,
        second_attached.client_id
    );
    assert_eq!(second_owner.owner_client_id, second_attached.client_id);
    assert!(second_owner_revision > first_owner_revision);

    send_viewer_state(&mut first, 7, "ownership", 3, true, false, 60, 20).await;
    read_viewport_status(&mut first).await;
    send_viewer_state(&mut first, 8, "ownership", 4, true, true, 60, 20).await;
    let equal_size_owner = read_viewport_status(&mut first).await;
    let equal_size_follower = read_viewport_status(&mut second).await;
    assert_eq!(equal_size_owner.owner_client_id, first_attached.client_id);
    assert_eq!(
        equal_size_follower.owner_client_id,
        first_attached.client_id
    );
    assert!(equal_size_owner.source_revision >= second_owner_revision);
    assert!(equal_size_owner.ownership_epoch > second_owner.ownership_epoch);

    send_viewer_state(&mut first, 9, "ownership", 5, false, false, 60, 20).await;
    let released = read_viewport_status(&mut first).await;
    let fallback = read_viewport_status(&mut second).await;
    assert_eq!(released.owner_client_id, second_attached.client_id);
    assert_eq!(fallback.owner_client_id, second_attached.client_id);
    assert!(fallback.source_revision >= second_owner_revision);

    send_viewer_state(&mut first, 10, "ownership", 5, true, true, 60, 20).await;
    let error = read_error(&mut first).await;
    assert!(error.contains("stale terminal viewer sequence"));

    send_viewer_state(&mut first, 11, "ownership", 6, false, true, 60, 20).await;
    let error = read_error(&mut first).await;
    assert!(error.contains("inactive terminal viewer cannot claim ownership"));

    send_viewer_state(&mut first, 12, "ownership", 7, true, true, 0, 20).await;
    let error = read_error(&mut first).await;
    assert!(error.contains("columns must be between 1 and 512"));

    manager_task.abort();
}

async fn send_viewer_state(
    framed: &mut pty_manager::transport::TerminalFramed,
    request_id: u64,
    session_name: &str,
    sequence: u64,
    active: bool,
    claim: bool,
    columns: u32,
    rows: u32,
) {
    send(
        framed,
        &protocol::envelope(
            request_id,
            session_name,
            Payload::TerminalViewerState(protocol::TerminalViewerState {
                sequence,
                active,
                claim,
                columns,
                rows,
            }),
        ),
    )
    .await
    .expect("send viewer state");
}

async fn wait_for_socket(socket_path: &Path) {
    support::ensure_vault_for_manager(socket_path);
    for _ in 0..100 {
        if UnixStream::connect(socket_path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "pty manager did not start listening at {}",
        socket_path.display()
    );
}

async fn send_create(
    framed: &mut pty_manager::transport::TerminalFramed,
    request_id: u64,
    session_name: &str,
    cwd: &Path,
) {
    send(
        framed,
        &protocol::envelope(
            request_id,
            session_name,
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: cwd.to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: format!("client {session_name}"),
            }),
        ),
    )
    .await
    .expect("create session");
}

async fn read_attached(framed: &mut pty_manager::transport::TerminalFramed) -> Attached {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Attached(attached) => return attached,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before attach: {other:?}"),
        }
    }
}

async fn read_client_detached(framed: &mut pty_manager::transport::TerminalFramed) -> u64 {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::ClientDetached(detached) => return detached.client_id,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before client detach: {other:?}"),
        }
    }
}

async fn read_until_output(
    framed: &mut pty_manager::transport::TerminalFramed,
    needle: &str,
) -> String {
    let mut output = Vec::new();
    for _ in 0..100 {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Output(frame) => {
                output.extend(frame.data);
                if String::from_utf8_lossy(&output).contains(needle) {
                    return String::from_utf8_lossy(&output).into_owned();
                }
            }
            Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload while waiting for output: {other:?}"),
        }
    }
    panic!(
        "output did not contain {needle:?}: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn read_checkpoint(framed: &mut pty_manager::transport::TerminalFramed) -> (u64, Vec<u8>) {
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
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload while waiting for checkpoint: {other:?}"),
        }
    }
}

async fn read_checkpoint_with_dimensions(
    framed: &mut pty_manager::transport::TerminalFramed,
    columns: u32,
    rows: u32,
) -> (u64, Vec<u8>) {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::TerminalCheckpointBegin(begin) => {
                assert_eq!((begin.columns, begin.rows), (columns, rows));
                let checkpoint_id = begin.checkpoint_id;
                let revision = begin.revision;
                let expected_chunks = begin.chunk_count;
                let mut chunks = 0;
                let mut bytes = Vec::new();
                loop {
                    let envelope = receive(framed).await.expect("receive").expect("frame");
                    match protocol::payload(envelope).expect("payload") {
                        Payload::TerminalCheckpointChunk(chunk) => {
                            assert_eq!(chunk.checkpoint_id, checkpoint_id);
                            assert_eq!(chunk.index, chunks);
                            chunks += 1;
                            bytes.extend(chunk.data);
                        }
                        Payload::TerminalCheckpointEnd(end) => {
                            assert_eq!(end.checkpoint_id, checkpoint_id);
                            assert_eq!(end.revision, revision);
                            assert_eq!(chunks, expected_chunks);
                            return (revision, bytes);
                        }
                        Payload::Output(_) | Payload::TerminalViewportStatus(_) => {}
                        Payload::Error(error) => panic!("pty manager error: {}", error.message),
                        other => panic!("unexpected payload during resize checkpoint: {other:?}"),
                    }
                }
            }
            Payload::Output(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before resize checkpoint: {other:?}"),
        }
    }
}

async fn read_output_revisions(
    framed: &mut pty_manager::transport::TerminalFramed,
    needle: &str,
) -> u64 {
    let mut first_revision = None;
    let mut previous_revision = None;
    let mut output = Vec::new();
    for _ in 0..100 {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Output(frame) => {
                first_revision.get_or_insert(frame.revision);
                if let Some(previous) = previous_revision {
                    assert_eq!(frame.revision, previous + 1);
                }
                previous_revision = Some(frame.revision);
                output.extend(frame.data);
                if String::from_utf8_lossy(&output).contains(needle) {
                    return first_revision.expect("first output revision");
                }
            }
            Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload while waiting for live output: {other:?}"),
        }
    }
    panic!("output did not contain {needle:?}");
}

async fn read_viewport_status(
    framed: &mut pty_manager::transport::TerminalFramed,
) -> protocol::TerminalViewportStatus {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::TerminalViewportStatus(status) => return status,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before viewport status: {other:?}"),
        }
    }
}

async fn read_error(framed: &mut pty_manager::transport::TerminalFramed) -> String {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Error(error) => return error.message,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            other => panic!("unexpected payload before error: {other:?}"),
        }
    }
}

async fn read_session_exited(framed: &mut pty_manager::transport::TerminalFramed) -> SessionExited {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionExited(exited) => return exited,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before exit: {other:?}"),
        }
    }
}
