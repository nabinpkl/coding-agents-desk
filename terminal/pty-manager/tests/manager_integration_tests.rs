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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
        leased_session_grace: Duration::from_secs(30),
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
async fn command_launch_preserves_exact_arguments_and_terminal_environment() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/argv_fixture.sh")
        .canonicalize()
        .expect("canonical fixture path");
    let arguments = vec![
        "plain".to_owned(),
        "two words".to_owned(),
        "$HOME".to_owned(),
        "$(printf expanded)".to_owned(),
        "*.rs; echo injected".to_owned(),
    ];

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    send(
        &mut client,
        &protocol::envelope(
            1,
            "command-main",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    executable: executable.to_string_lossy().into_owned(),
                    arguments,
                })),
                lifetime: SessionLifetime::Persistent as i32,
                columns: 93,
                rows: 31,
                create_if_missing: true,
                client_title: "command client".to_owned(),
            }),
        ),
    )
    .await
    .expect("create command session");

    let (attached, output, status) =
        read_attached_output_and_exit(&mut client, 1, "command-main").await;
    assert_eq!(status, 0);
    assert_eq!(attached.cwd, tempdir.path().to_string_lossy());
    assert_eq!(attached.shell, executable.to_string_lossy());
    assert!(
        output.contains("env=<xterm-256color>|<truecolor>|<agentdesk>|<command-main>"),
        "missing terminal environment in fixture output: {output}"
    );
    for expected in [
        "arg[0]=<plain>",
        "arg[1]=<two words>",
        "arg[2]=<$HOME>",
        "arg[3]=<$(printf expanded)>",
        "arg[4]=<*.rs; echo injected>",
    ] {
        assert!(
            output.contains(expected),
            "missing exact argument {expected:?} in fixture output: {output}"
        );
    }

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_launch_summary_identifies_direct_executable() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/argv_fixture.sh")
        .canonicalize()
        .expect("canonical fixture path");
    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    send(
        &mut client,
        &protocol::envelope(
            1,
            "command-summary",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    executable: executable.to_string_lossy().into_owned(),
                    arguments: vec!["--wait-for-input".to_owned()],
                })),
                lifetime: SessionLifetime::Persistent as i32,
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "command summary client".to_owned(),
            }),
        ),
    )
    .await
    .expect("create command session");

    let attached = read_attached(&mut client).await;
    assert_eq!(attached.cwd, tempdir.path().to_string_lossy());
    assert_eq!(attached.shell, executable.to_string_lossy());
    read_until_output(&mut client, "arg[0]=<--wait-for-input>").await;

    send(
        &mut client,
        &protocol::envelope(2, "", Payload::ListSessions(ListSessions {})),
    )
    .await
    .expect("list command sessions");
    let list = read_session_list_without_duplicate_attach(&mut client, 2).await;
    let summary = list
        .sessions
        .iter()
        .find(|session| session.name == "command-summary")
        .expect("command session summary");
    assert_eq!(summary.cwd, tempdir.path().to_string_lossy());
    assert_eq!(summary.shell, executable.to_string_lossy());
    assert_eq!(summary.lifetime(), SessionLifetime::Persistent);

    send(
        &mut client,
        &protocol::envelope(
            3,
            "command-summary",
            Payload::Input(Input {
                data: b"release\n".to_vec(),
            }),
        ),
    )
    .await
    .expect("release command fixture");
    assert_eq!(read_until_session_exit(&mut client).await, 0);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_launch_rejects_empty_executable() {
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
            "invalid-command",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    executable: String::new(),
                    arguments: vec!["ignored".to_owned()],
                })),
                lifetime: SessionLifetime::Persistent as i32,
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "invalid command client".to_owned(),
            }),
        ),
    )
    .await
    .expect("send invalid command creation");

    let envelope = receive(&mut client).await.expect("receive").expect("frame");
    match protocol::payload(envelope).expect("payload") {
        Payload::Error(error) => assert!(
            error.message.contains("command executable"),
            "unexpected protocol error: {}",
            error.message
        ),
        other => panic!("expected command executable error, got {other:?}"),
    }

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_ignores_launch_and_cannot_change_original_lifetime() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(30),
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
    send(
        &mut matching_attach,
        &protocol::envelope(20, "", Payload::ListSessions(ListSessions {})),
    )
    .await
    .expect("list sessions after attach");
    read_session_list_without_duplicate_attach(&mut matching_attach, 20).await;

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
    let list = read_session_list_without_duplicate_attach(&mut creator, 4).await;
    assert_eq!(list.sessions[0].lifetime(), SessionLifetime::Persistent);

    manager_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_missing_session_returns_error() {
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
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
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
            Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload while waiting for output: {other:?}"),
        }
    }
    panic!(
        "output did not contain {needle:?}: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn read_attached_output_and_exit(
    framed: &mut pty_manager::transport::TerminalFramed,
    request_id: u64,
    session_name: &str,
) -> (Attached, String, i32) {
    let first = tokio::time::timeout(Duration::from_secs(1), receive(framed))
        .await
        .expect("timed out waiting for attached response")
        .expect("receive")
        .expect("frame");
    assert_eq!(first.request_id, request_id);
    assert_eq!(first.session_name, session_name);
    let attached = match protocol::payload(first).expect("payload") {
        Payload::Attached(attached) => attached,
        other => panic!("expected Attached as first command session frame, got {other:?}"),
    };
    let mut output = Vec::new();

    for _ in 0..100 {
        let envelope = tokio::time::timeout(Duration::from_secs(1), receive(framed))
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "timed out waiting for command session exit; output={}",
                    String::from_utf8_lossy(&output)
                )
            })
            .expect("receive")
            .expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::Attached(_) => panic!("command session sent duplicate Attached response"),
            Payload::Output(frame) => output.extend(frame.data),
            Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
            Payload::SessionExited(exited) => {
                return (
                    attached,
                    String::from_utf8_lossy(&output).into_owned(),
                    exited.status,
                );
            }
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected command session payload: {other:?}"),
        }
    }

    panic!(
        "command session did not attach and exit; output: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn read_session_list_without_duplicate_attach(
    framed: &mut pty_manager::transport::TerminalFramed,
    request_id: u64,
) -> protocol::SessionList {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        let response_id = envelope.request_id;
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionList(list) if response_id == request_id => return list,
            Payload::Attached(_) => {
                panic!("existing session attach sent duplicate Attached response")
            }
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload after existing session attach: {other:?}"),
        }
    }
}

async fn read_until_session_exit(framed: &mut pty_manager::transport::TerminalFramed) -> i32 {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionExited(exited) => return exited.status,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_) => {}
            Payload::Attached(_) => panic!("command session sent duplicate Attached response"),
            Payload::Error(error) => panic!("pty manager error: {}", error.message),
            other => panic!("unexpected payload before command session exit: {other:?}"),
        }
    }
}
