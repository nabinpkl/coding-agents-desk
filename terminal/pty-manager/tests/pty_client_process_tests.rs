use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use tempfile::tempdir;
use tokio::net::UnixStream;

mod support;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_client_exits_when_child_session_exits_with_stdin_open() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
    });
    let manager_task = tokio::spawn(async move { manager.run().await });
    wait_for_socket(&socket_path).await;

    let mut client = spawn_pty_client(&socket_path, tempdir.path());
    send_exit_and_wait(&mut client).await;

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list sessions after first exit");
    assert!(sessions.is_empty());

    let mut client = spawn_pty_client(&socket_path, tempdir.path());
    send_exit_and_wait(&mut client).await;

    let sessions = pty_manager::client::list_sessions(&socket_path)
        .await
        .expect("list sessions after second exit");
    assert!(sessions.is_empty());

    manager_task.abort();
}

fn spawn_pty_client(socket_path: &Path, cwd: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_pty-client"))
        .args([
            "--socket",
            socket_path.to_str().expect("socket path"),
            "--session",
            "main",
            "--cwd",
            cwd.to_str().expect("cwd"),
            "--shell",
            "/bin/sh",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn pty-client")
}

async fn send_exit_and_wait(client: &mut Child) {
    let mut stdin = client.stdin.take().expect("client stdin");
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::io::Write::write_all(&mut stdin, b"exit\n").expect("write exit");
    std::io::Write::flush(&mut stdin).expect("flush exit");

    let status = wait_for_child_exit(client).await;
    assert!(status.success(), "pty-client exited with {status}");
    drop(stdin);
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

async fn wait_for_child_exit(child: &mut Child) -> ExitStatus {
    for _ in 0..100 {
        if let Some(status) = child.try_wait().expect("try wait pty-client") {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.kill().expect("kill hung pty-client");
    panic!("pty-client stayed running after child session exited");
}
