#![cfg(target_os = "macos")]

use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use pty_manager::vault::{Vault, VaultOptions};
use pty_manager::vault_client::VaultClient;

static VAULTS: OnceLock<Mutex<Vec<RunningVault>>> = OnceLock::new();

pub struct RunningVault {
    socket_path: PathBuf,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl RunningVault {
    pub fn start(socket_path: PathBuf, max_sessions: usize) -> Self {
        // Wait for any previous listener on this path to actually go away.
        //
        // Dropping a RunningVault joins its accept loop, but that is not the same as the socket
        // being free: `handle_client` spawns a thread per connection holding an Arc to the runtime
        // that owns the listener, so the socket stays bound until the last handler finishes. A
        // replacement that binds on top of that fails with ManagerAlreadyListening, which is a
        // race in this harness rather than a fault in the vault, and the manager polls its vault
        // every 50-250ms so there is usually a handler in flight to lose it to.
        for _ in 0..500 {
            if StdUnixStream::connect(&socket_path).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
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
        // `cargo test` runs every test binary at once and each spawns vaults and PTYs, so a 2s
        // budget here fails under nothing worse than load: the suite passes in isolation and
        // reports a bogus "vault socket did not become ready" when run whole. Give startup room,
        // and name the socket so a real failure is not mistaken for this again.
        for _ in 0..1_000 {
            if readiness_client.list().is_ok() {
                return Self {
                    socket_path,
                    shutdown,
                    thread: Some(thread),
                };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("vault socket did not become ready: {}", socket_path.display());
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

pub fn ensure_vault_for_manager(manager_socket_path: &Path) {
    let socket_path = manager_socket_path.with_file_name("pty-vault.sock");
    let vaults = VAULTS.get_or_init(|| Mutex::new(Vec::new()));
    let mut vaults = vaults.lock().expect("lock test vaults");
    if vaults.iter().any(|vault| vault.socket_path == socket_path) {
        return;
    }
    vaults.push(RunningVault::start(socket_path, 64));
}

#[allow(dead_code)]
pub fn restart_vault_for_manager(manager_socket_path: &Path) {
    let socket_path = manager_socket_path.with_file_name("pty-vault.sock");
    let vaults = VAULTS.get_or_init(|| Mutex::new(Vec::new()));
    let old = {
        let mut vaults = vaults.lock().expect("lock test vaults");
        vaults
            .iter()
            .position(|vault| vault.socket_path == socket_path)
            .map(|index| vaults.remove(index))
    };
    drop(old);
    let replacement = RunningVault::start(socket_path, 64);
    VAULTS
        .get()
        .expect("test vault registry")
        .lock()
        .expect("lock test vaults")
        .push(replacement);
}

#[allow(dead_code)]
pub fn close_all_vault_sessions(manager_socket_path: &Path) {
    let client = VaultClient::new(manager_socket_path.with_file_name("pty-vault.sock"));
    for session in client.list().expect("list vault sessions for cleanup") {
        if !session.exited {
            client
                .kill(&session.name, session.generation)
                .expect("close vault session");
        } else {
            let _ = client.exit_status(&session.name, session.generation, true);
        }
    }
}
