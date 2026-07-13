use std::path::Path;
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CommandLaunch, CreateOrAttach, Input, ListSessions, Payload,
    Resize, SessionLifetime, ShellLaunch,
};
use pty_manager::transport::{receive, send};
use tempfile::tempdir;
use tokio::net::UnixStream;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_updates_child_pty_size() {
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

    send(
        &mut client,
        &protocol::envelope(
            2,
            "main",
            Payload::Resize(Resize {
                columns: 100,
                rows: 17,
            }),
        ),
    )
    .await
    .expect("resize session");
    send(
        &mut client,
        &protocol::envelope(
            3,
            "main",
            Payload::Input(Input {
                data: b"stty size\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send stty");
    read_until_output(&mut client, "17 100").await;

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawned_session_reports_terminal_environment() {
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

    send(
        &mut client,
        &protocol::envelope(
            2,
            "main",
            Payload::Input(Input {
                data: b"printf '%s|%s|%s\\n' \"$TERM\" \"$COLORTERM\" \"$TERM_PROGRAM\"\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send env probe");
    read_until_output(&mut client, "xterm-256color|truecolor|agentdesk").await;

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawned_session_uses_login_interactive_shell() {
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

    send(
        &mut client,
        &protocol::envelope(
            2,
            "main",
            Payload::Input(Input {
                data: b"printf 'shell-zero:%s flags:%s\\n' \"$0\" \"$-\"\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send shell mode probe");
    let output = read_until_output(&mut client, "shell-zero:-sh flags:").await;
    let (_, flags) = output
        .split_once("shell-zero:-sh flags:")
        .expect("shell mode output");
    assert!(
        flags.contains('i'),
        "expected interactive shell flags to contain i: {output}"
    );

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawned_session_uses_delete_as_erase_key() {
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

    send(
        &mut client,
        &protocol::envelope(
            2,
            "main",
            Payload::Input(Input {
                data: b"stty -a\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("send stty probe");
    read_until_output(&mut client, "erase = ^?").await;

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_ignores_launch_and_cannot_change_original_lifetime() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut creator = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect creator");
    send_create(&mut creator, 1, "main", tempdir.path()).await;
    let original = read_attached(&mut creator).await;

    let mut matching_attach = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect matching attach");
    send(
        &mut matching_attach,
        &protocol::envelope(
            2,
            "main",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: "/ignored/cwd".to_owned(),
                    executable: "/ignored/executable".to_owned(),
                    arguments: vec!["ignored argument".to_owned()],
                })),
                lifetime: SessionLifetime::Persistent as i32,
                columns: 100,
                rows: 30,
                create_if_missing: false,
                client_title: "matching attach".to_owned(),
            }),
        ),
    )
    .await
    .expect("attach existing session");
    let attached = read_attached(&mut matching_attach).await;
    assert_eq!(attached.pid, original.pid);
    assert_eq!(attached.cwd, original.cwd);
    assert_eq!(attached.shell, original.shell);

    let mut mismatched_attach = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect mismatched attach");
    send(
        &mut mismatched_attach,
        &protocol::envelope(
            3,
            "main",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                lifetime: SessionLifetime::Leased as i32,
                columns: 80,
                rows: 24,
                create_if_missing: false,
                client_title: "mismatched attach".to_owned(),
            }),
        ),
    )
    .await
    .expect("send mismatched attach");
    let mismatch = receive(&mut mismatched_attach)
        .await
        .expect("receive mismatch")
        .expect("mismatch frame");
    match protocol::payload(mismatch).expect("mismatch payload") {
        Payload::Error(error) => assert!(error.message.contains("lifetime"), "{}", error.message),
        other => panic!("expected lifetime error, got {other:?}"),
    }

    send(
        &mut creator,
        &protocol::envelope(4, "", Payload::ListSessions(ListSessions {})),
    )
    .await
    .expect("list sessions");
    let list = receive(&mut creator)
        .await
        .expect("receive list")
        .expect("list frame");
    let Payload::SessionList(list) = protocol::payload(list).expect("list payload") else {
        panic!("expected session list");
    };
    assert_eq!(list.sessions[0].lifetime(), SessionLifetime::Persistent);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_missing_session_returns_error() {
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
            Payload::Resize(Resize {
                columns: 100,
                rows: 17,
            }),
        ),
    )
    .await
    .expect("resize missing session");

    let envelope = receive(&mut client).await.expect("receive").expect("frame");
    match protocol::payload(envelope).expect("payload") {
        Payload::Error(error) => assert!(error.message.contains("missing")),
        other => panic!("unexpected payload for missing resize: {other:?}"),
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
