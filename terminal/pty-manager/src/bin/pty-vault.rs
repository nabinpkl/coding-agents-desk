use std::path::PathBuf;

use clap::Parser;
use pty_manager::vault::{Vault, VaultOptions};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "/tmp/pty-vault.sock")]
    socket: PathBuf,

    #[arg(long, default_value_t = 64)]
    max_sessions: usize,

    #[arg(long)]
    handover: bool,

    #[arg(long)]
    runtime_digest: Option<String>,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    // Default to info rather than the empty filter's ERROR. The host captures this stream to a
    // per-launch file and reads it back when a candidate fails, so a silent daemon means a failed
    // update reports "did not activate" and nothing else.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        // Never a terminal: the host captures this to a per-launch file and reads it back into its
        // own log, where escape codes are noise.
        .with_ansi(false)
        .init();
    tracing::info!(
        socket = %args.socket.display(),
        pid = std::process::id(),
        mode = if args.handover { "handover" } else { "cold" },
        // Which build this is. Correlating a daemon's log with the host's decisions otherwise
        // meant reading --runtime-digest out of its command line.
        digest = args
            .runtime_digest
            .as_deref()
            .map(|digest| &digest[..digest.len().min(12)])
            .unwrap_or("none"),
        "pty vault starting"
    );
    let socket_path = args.socket;
    let identity_socket_path = socket_path.clone();
    let runtime_digest = args.runtime_digest;
    let publish_identity = move || {
        if let Some(digest) = &runtime_digest {
            pty_manager::runtime_identity::publish(&identity_socket_path, digest)?;
        }
        Ok(())
    };
    let options = VaultOptions {
        socket_path,
        max_sessions: args.max_sessions,
    };
    if args.handover {
        Vault::handover_with_ready(options, publish_identity)?;
    } else {
        Vault::new(options)?.run_with_ready(publish_identity)?;
    }
    Ok(())
}
