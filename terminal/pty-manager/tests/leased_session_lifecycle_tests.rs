use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CommandLaunch, CreateOrAttach, Detach, Payload,
    SessionLifetime, ShellLaunch,
};
use pty_manager::transport::{receive, send, TerminalFramed};
use tempfile::{tempdir, TempDir};
use tokio::net::UnixStream;
use tokio::task::JoinHandle;

mod support;

const TEST_GRACE: Duration = Duration::from_millis(80);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leased_final_detach_reaps_and_allows_clean_recreation() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut client = manager.connect().await;
    let original = create_shell(&mut client, "leased", manager.root(), true).await;

    detach(&mut client, "leased").await;
    drop(client);
    wait_for_no_sessions(&manager.socket_path).await;
    wait_for_process_exit(original.pid).await;

    let mut recreated = manager.connect().await;
    let attached = create_shell(&mut recreated, "leased", manager.root(), true).await;
    assert!(attached.pid > 0);
    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].clients.len(), 1);
    assert_eq!(sessions[0].clients[0].id, attached.client_id);
    manager.shutdown(&[attached.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leased_session_waits_for_final_of_two_clients() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut first = manager.connect().await;
    let original = create_shell(&mut first, "shared", manager.root(), true).await;
    let mut second = manager.connect().await;
    let attached = create_shell(&mut second, "shared", manager.root(), false).await;
    assert_eq!(attached.pid, original.pid);

    detach(&mut first, "shared").await;
    drop(first);
    tokio::time::sleep(TEST_GRACE * 2).await;

    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].pid, original.pid);
    assert_eq!(sessions[0].clients.len(), 1);
    assert_eq!(sessions[0].clients[0].id, attached.client_id);
    manager.shutdown(&[original.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leased_reattach_cancels_reap_and_later_detach_starts_fresh_grace() {
    let grace = Duration::from_millis(150);
    let manager = RunningManager::start(grace).await;
    let mut first = manager.connect().await;
    let original = create_shell(&mut first, "reconnect", manager.root(), true).await;
    detach(&mut first, "reconnect").await;
    drop(first);

    tokio::time::sleep(Duration::from_millis(30)).await;
    let mut second = manager.connect().await;
    let reattached = create_shell(&mut second, "reconnect", manager.root(), false).await;
    assert_eq!(reattached.pid, original.pid);

    tokio::time::sleep(grace * 2).await;
    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].pid, original.pid);

    detach(&mut second, "reconnect").await;
    drop(second);
    wait_for_no_sessions(&manager.socket_path).await;
    wait_for_process_exit(original.pid).await;
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_socket_reaps_final_lease() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut client = manager.connect().await;
    let attached = create_shell(&mut client, "dropped", manager.root(), true).await;

    drop(client);
    wait_for_no_sessions(&manager.socket_path).await;
    wait_for_process_exit(attached.pid).await;
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_client_reaps_final_lease() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut terminal = manager.connect().await;
    let attached = create_shell(&mut terminal, "closed", manager.root(), true).await;

    let closed =
        pty_manager::client::close_client(&manager.socket_path, "closed", attached.client_id)
            .await
            .expect("close final client");
    assert_eq!(closed, attached.client_id);
    wait_for_no_sessions(&manager.socket_path).await;
    wait_for_process_exit(attached.pid).await;
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grace_expiry_broadcasts_empty_session_snapshot() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut subscriber = pty_manager::client::subscribe_sessions(&manager.socket_path)
        .await
        .expect("subscribe sessions");
    assert!(
        pty_manager::client::receive_session_snapshot(&mut subscriber)
            .await
            .expect("initial snapshot")
            .is_empty()
    );

    let mut client = manager.connect().await;
    let attached = create_shell(&mut client, "observed", manager.root(), true).await;
    let created = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("created snapshot");
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].clients.len(), 1);

    detach(&mut client, "observed").await;
    drop(client);
    let detached = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("detached snapshot");
    assert_eq!(detached.len(), 1);
    assert!(detached[0].clients.is_empty());

    let reaped = pty_manager::client::receive_session_snapshot(&mut subscriber)
        .await
        .expect("reaped snapshot");
    assert!(reaped.is_empty());
    wait_for_process_exit(attached.pid).await;
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_kill_is_immediate_and_old_timer_cannot_kill_recreated_name() {
    let grace = Duration::from_millis(150);
    let manager = RunningManager::start(grace).await;
    let mut first = manager.connect().await;
    let original = create_shell(&mut first, "recreated", manager.root(), true).await;
    detach(&mut first, "recreated").await;
    drop(first);

    assert_eq!(
        pty_manager::client::kill_session(&manager.socket_path, "recreated")
            .await
            .expect("kill detached leased session"),
        129
    );
    assert!(list_sessions(&manager.socket_path).await.is_empty());
    wait_for_process_exit(original.pid).await;

    let mut second = manager.connect().await;
    let recreated = create_shell(&mut second, "recreated", manager.root(), true).await;
    tokio::time::sleep(grace * 2).await;
    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].pid, recreated.pid);
    assert_eq!(sessions[0].clients.len(), 1);
    manager.shutdown(&[recreated.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn natural_exit_clears_leased_session_state() {
    let manager = RunningManager::start(TEST_GRACE).await;
    let mut client = manager.connect().await;
    send(
        &mut client,
        &protocol::envelope(
            1,
            "natural-exit",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: manager.root().to_string_lossy().into_owned(),
                    executable: "/bin/sh".to_owned(),
                    arguments: vec!["-c".to_owned(), "exit 7".to_owned()],
                })),
                lifetime: SessionLifetime::Leased as i32,
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "natural exit".to_owned(),
            }),
        ),
    )
    .await
    .expect("create naturally exiting session");

    let attached = read_first_attached(&mut client, 1, "natural-exit").await;
    assert_eq!(read_session_exit(&mut client).await, 7);
    wait_for_no_sessions(&manager.socket_path).await;
    wait_for_process_exit(attached.pid).await;
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manager_shutdown_preserves_leased_child_in_vault() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
        leased_session_grace: Duration::from_secs(5),
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let manager_task = tokio::spawn(async move {
        manager
            .run_until_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("manager run");
    });
    wait_for_socket(&socket_path).await;

    let mut client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect client");
    let attached = create_shell(&mut client, "shutdown", tempdir.path(), true).await;
    assert!(process_exists(attached.pid));

    let marker = tempdir.path().join("racing-child.pid");
    let mut racing_client = pty_manager::client::connect(&socket_path)
        .await
        .expect("connect racing client");
    send(
        &mut racing_client,
        &protocol::envelope(
            2,
            "shutdown-race",
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                    cwd: tempdir.path().to_string_lossy().into_owned(),
                    executable: "/bin/sh".to_owned(),
                    arguments: vec![
                        "-c".to_owned(),
                        "echo $$ > \"$1\"; sleep 30".to_owned(),
                        "shutdown-fixture".to_owned(),
                        marker.to_string_lossy().into_owned(),
                    ],
                })),
                lifetime: SessionLifetime::Leased as i32,
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "shutdown race".to_owned(),
            }),
        ),
    )
    .await
    .expect("queue racing leased creation");

    shutdown_tx.send(()).expect("signal manager shutdown");
    tokio::time::timeout(Duration::from_secs(2), manager_task)
        .await
        .expect("manager shutdown timed out")
        .expect("manager task failed");
    assert!(
        process_exists(attached.pid),
        "vault did not preserve child after manager shutdown"
    );
    let mut preserved_pids = vec![attached.pid];
    if let Ok(contents) = fs::read_to_string(marker) {
        let racing_pid = contents.trim().parse::<u32>().expect("racing child pid");
        assert!(
            process_exists(racing_pid),
            "vault did not preserve racing child after manager shutdown"
        );
        preserved_pids.push(racing_pid);
    }
    support::close_all_vault_sessions(&socket_path);
    for pid in preserved_pids {
        wait_for_process_exit(pid).await;
    }
}

struct RunningManager {
    _tempdir: TempDir,
    socket_path: std::path::PathBuf,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl RunningManager {
    async fn start(leased_session_grace: Duration) -> Self {
        let tempdir = tempdir().expect("tempdir");
        let socket_path = tempdir.path().join("terminal.sock");
        let manager = PtyManager::new(PtyManagerOptions {
            socket_path: socket_path.clone(),
            leased_session_grace,
        });
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            manager
                .run_until_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("manager run");
        });
        wait_for_socket(&socket_path).await;
        Self {
            _tempdir: tempdir,
            socket_path,
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
        }
    }

    fn root(&self) -> &Path {
        self._tempdir.path()
    }

    async fn connect(&self) -> TerminalFramed {
        pty_manager::client::connect(&self.socket_path)
            .await
            .expect("connect client")
    }

    async fn shutdown(mut self, leased_pids: &[u32]) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            shutdown_tx.send(()).expect("signal manager shutdown");
        }
        if let Some(task) = self.task.take() {
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("manager shutdown timed out")
                .expect("manager task failed");
        }
        for pid in leased_pids {
            assert!(
                process_exists(*pid),
                "leased child {pid} did not survive manager shutdown"
            );
        }
        support::close_all_vault_sessions(&self.socket_path);
        for pid in leased_pids {
            wait_for_process_exit(*pid).await;
        }
    }
}

impl Drop for RunningManager {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
    }
}

async fn create_shell(
    framed: &mut TerminalFramed,
    session_name: &str,
    cwd: &Path,
    create_if_missing: bool,
) -> Attached {
    send(
        framed,
        &protocol::envelope(
            1,
            session_name,
            Payload::CreateOrAttach(CreateOrAttach {
                launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                    cwd: cwd.to_string_lossy().into_owned(),
                    shell: "/bin/sh".to_owned(),
                })),
                lifetime: SessionLifetime::Leased as i32,
                columns: 80,
                rows: 24,
                create_if_missing,
                client_title: format!("client {session_name}"),
            }),
        ),
    )
    .await
    .expect("create or attach leased session");
    read_first_attached(framed, 1, session_name).await
}

async fn detach(framed: &mut TerminalFramed, session_name: &str) {
    send(
        framed,
        &protocol::envelope(2, session_name, Payload::Detach(Detach {})),
    )
    .await
    .expect("detach client");
}

async fn read_first_attached(
    framed: &mut TerminalFramed,
    request_id: u64,
    session_name: &str,
) -> Attached {
    let envelope = receive(framed).await.expect("receive").expect("frame");
    assert_eq!(envelope.request_id, request_id);
    assert_eq!(envelope.session_name, session_name);
    match protocol::payload(envelope).expect("payload") {
        Payload::Attached(attached) => attached,
        other => panic!("expected Attached first, got {other:?}"),
    }
}

async fn read_session_exit(framed: &mut TerminalFramed) -> i32 {
    loop {
        let envelope = receive(framed).await.expect("receive").expect("frame");
        match protocol::payload(envelope).expect("payload") {
            Payload::SessionExited(exited) => return exited.status,
            Payload::Output(_)
            | Payload::TerminalCheckpointBegin(_)
            | Payload::TerminalCheckpointChunk(_)
            | Payload::TerminalCheckpointEnd(_)
            | Payload::TerminalViewportStatus(_) => {}
            other => panic!("expected session exit, got {other:?}"),
        }
    }
}

async fn list_sessions(socket_path: &Path) -> Vec<protocol::SessionSummary> {
    pty_manager::client::list_sessions(socket_path)
        .await
        .expect("list sessions")
}

async fn wait_for_no_sessions(socket_path: &Path) {
    for _ in 0..100 {
        if list_sessions(socket_path).await.is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("session state remained after lifecycle cleanup");
}

async fn wait_for_socket(socket_path: &Path) {
    support::ensure_vault_for_manager(socket_path);
    for _ in 0..100 {
        if UnixStream::connect(socket_path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("pty manager did not create socket");
}

fn process_exists(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("probe child pid")
        .success()
}

async fn wait_for_process_exit(pid: u32) {
    for _ in 0..100 {
        if !process_exists(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("leased child {pid} survived manager shutdown");
}
