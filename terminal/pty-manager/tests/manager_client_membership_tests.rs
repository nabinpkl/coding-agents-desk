use std::path::Path;
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CreateOrAttach, Detach, Input, KillSession, Payload,
    SessionExited, SessionLifetime, ShellLaunch,
};
use pty_manager::transport::{receive, send};
use tempfile::tempdir;
use tokio::net::UnixStream;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_final_detach_survives_grace_until_killed() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_millis(40),
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
                lifetime: SessionLifetime::Persistent as i32,
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
                lifetime: SessionLifetime::Persistent as i32,
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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
                lifetime: SessionLifetime::Persistent as i32,
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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
                lifetime: SessionLifetime::Persistent as i32,
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

async fn wait_for_socket(socket_path: &Path) {
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
                lifetime: SessionLifetime::Persistent as i32,
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
            Payload::Output(_) => {}
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
            Payload::Output(_) => {}
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
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload while waiting for output: {other:?}"),
        }
    }
    panic!(
        "output did not contain {needle:?}: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn read_session_exited(framed: &mut pty_manager::transport::TerminalFramed) -> SessionExited {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionExited(exited) => return exited,
            Payload::Output(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before exit: {other:?}"),
        }
    }
}
