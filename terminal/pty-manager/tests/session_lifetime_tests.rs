//! A session lives exactly as long as its process. Detaching - however it happens - never ends one,
//! so a rebuilt host, a backgrounded phone, and a dropped socket all leave the terminal running.
//! The only things that end a session are its process exiting and someone explicitly killing it.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use pty_manager::manager::{PtyManager, PtyManagerOptions};
use pty_manager::protocol::{
    self, create_or_attach, Attached, CommandLaunch, CreateOrAttach, Detach, Payload, ShellLaunch,
};
use pty_manager::transport::{receive, send, TerminalFramed};
use tempfile::{tempdir, TempDir};
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

mod support;

/// Comfortably longer than the reap grace this manager used to run, so a session that would have
/// been killed by the old timer has had every chance to die before the assertion.
const FORMER_GRACE_WINDOW: Duration = Duration::from_millis(400);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn final_detach_keeps_the_session_running_for_reattach() {
    let manager = RunningManager::start().await;
    let mut client = manager.connect().await;
    let original = create_shell(&mut client, "detached", manager.root(), true).await;

    detach(&mut client, "detached").await;
    drop(client);
    tokio::time::sleep(FORMER_GRACE_WINDOW).await;

    assert!(
        process_exists(original.pid),
        "the last client letting go killed the session"
    );
    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].clients.is_empty());

    // The point of keeping it: reattaching lands on the same process, not a fresh shell.
    let mut reattached = manager.connect().await;
    let attached = create_shell(&mut reattached, "detached", manager.root(), false).await;
    assert_eq!(attached.pid, original.pid);
    manager.shutdown(&[original.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_outlives_every_client_detaching() {
    let manager = RunningManager::start().await;
    let mut first = manager.connect().await;
    let original = create_shell(&mut first, "shared", manager.root(), true).await;
    let mut second = manager.connect().await;
    assert_eq!(
        create_shell(&mut second, "shared", manager.root(), false)
            .await
            .pid,
        original.pid
    );

    detach(&mut first, "shared").await;
    drop(first);
    detach(&mut second, "shared").await;
    drop(second);
    tokio::time::sleep(FORMER_GRACE_WINDOW).await;

    let sessions = list_sessions(&manager.socket_path).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].pid, original.pid);
    assert!(sessions[0].clients.is_empty());
    manager.shutdown(&[original.pid]).await;
}

/// A dropped connection is a transport fact, and the manager cannot tell one apart from a phone
/// going into a pocket. It must not be an ending.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_socket_leaves_the_session_running() {
    let manager = RunningManager::start().await;
    let mut client = manager.connect().await;
    let attached = create_shell(&mut client, "dropped", manager.root(), true).await;

    drop(client);
    tokio::time::sleep(FORMER_GRACE_WINDOW).await;

    assert!(process_exists(attached.pid));
    assert_eq!(list_sessions(&manager.socket_path).await.len(), 1);
    manager.shutdown(&[attached.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_client_leaves_the_session_running() {
    let manager = RunningManager::start().await;
    let mut terminal = manager.connect().await;
    let attached = create_shell(&mut terminal, "closed", manager.root(), true).await;

    let closed =
        pty_manager::client::close_client(&manager.socket_path, "closed", attached.client_id)
            .await
            .expect("close final client");
    assert_eq!(closed, attached.client_id);
    tokio::time::sleep(FORMER_GRACE_WINDOW).await;

    assert!(process_exists(attached.pid));
    assert_eq!(list_sessions(&manager.socket_path).await.len(), 1);
    manager.shutdown(&[attached.pid]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_kill_ends_a_detached_session_immediately() {
    let manager = RunningManager::start().await;
    let mut client = manager.connect().await;
    let original = create_shell(&mut client, "killed", manager.root(), true).await;
    detach(&mut client, "killed").await;
    drop(client);
    let exit_event = observe_exit(original.pid);

    assert_eq!(
        pty_manager::client::kill_session(&manager.socket_path, "killed")
            .await
            .expect("kill detached session"),
        129
    );
    assert!(list_sessions(&manager.socket_path).await.is_empty());
    wait_for_exit_event(original.pid, exit_event).await;
    manager.shutdown(&[]).await;
}

/// The one reaper left. It fires off the process, not off client presence, so it works the same
/// whether or not anyone is watching.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn natural_exit_clears_session_state() {
    let manager = RunningManager::start().await;
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
    assert!(!process_exists(attached.pid));
    manager.shutdown(&[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manager_shutdown_preserves_the_child_in_vault() {
    let tempdir = tempdir().expect("tempdir");
    let socket_path = tempdir.path().join("terminal.sock");
    let manager = PtyManager::new(PtyManagerOptions {
        socket_path: socket_path.clone(),
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
                columns: 80,
                rows: 24,
                create_if_missing: true,
                client_title: "shutdown race".to_owned(),
            }),
        ),
    )
    .await
    .expect("queue racing session creation");

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
    let exit_events = preserved_pids
        .iter()
        .copied()
        .map(|pid| (pid, observe_exit(pid)))
        .collect::<Vec<_>>();
    support::close_all_vault_sessions(&socket_path);
    for (pid, exit_event) in exit_events {
        wait_for_exit_event(pid, exit_event).await;
    }
}

struct RunningManager {
    _tempdir: TempDir,
    socket_path: std::path::PathBuf,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl RunningManager {
    async fn start() -> Self {
        let tempdir = tempdir().expect("tempdir");
        let socket_path = tempdir.path().join("terminal.sock");
        let manager = PtyManager::new(PtyManagerOptions {
            socket_path: socket_path.clone(),
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

    async fn shutdown(mut self, surviving_pids: &[u32]) {
        let exit_events = surviving_pids
            .iter()
            .copied()
            .map(|pid| (pid, observe_exit(pid)))
            .collect::<Vec<_>>();
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            shutdown_tx.send(()).expect("signal manager shutdown");
        }
        if let Some(task) = self.task.take() {
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("manager shutdown timed out")
                .expect("manager task failed");
        }
        for pid in surviving_pids {
            assert!(
                process_exists(*pid),
                "child {pid} did not survive manager shutdown"
            );
        }
        support::close_all_vault_sessions(&self.socket_path);
        for (pid, exit_event) in exit_events {
            wait_for_exit_event(pid, exit_event).await;
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
                columns: 80,
                rows: 24,
                create_if_missing,
                client_title: format!("client {session_name}"),
            }),
        ),
    )
    .await
    .expect("create or attach session");
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

fn observe_exit(pid: u32) -> oneshot::Receiver<Result<i32, String>> {
    // Arm this before SIGHUP: PID probing can remain successful for an
    // exited-but-unreaped child, while NOTE_EXIT is the lifecycle event the
    // vault itself relies on.
    let (sender, receiver) = oneshot::channel();
    std::thread::spawn(move || {
        let result = pty_manager::process_observer::observe_exit_status(pid)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    receiver
}

async fn wait_for_exit_event(pid: u32, exit_event: oneshot::Receiver<Result<i32, String>>) {
    let status = tokio::time::timeout(Duration::from_secs(10), exit_event)
        .await
        .unwrap_or_else(|_| panic!("child {pid} emitted no exit event"))
        .unwrap_or_else(|_| panic!("child {pid} exit observer stopped"))
        .unwrap_or_else(|error| panic!("child {pid} exit observer failed: {error}"));
    assert_eq!(status, 129, "child {pid} exited with an unexpected status");
}
