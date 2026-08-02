use std::path::PathBuf;

use clap::Parser;
use pty_manager::manager::{PtyManager, PtyManagerLimits, PtyManagerOptions};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "/tmp/pty-manager.sock")]
    socket: PathBuf,

    #[arg(long, default_value_t = 64)]
    max_sessions: usize,

    #[arg(long, default_value_t = 16)]
    max_clients_per_session: usize,

    #[arg(long, default_value_t = 512)]
    max_columns: u32,

    #[arg(long, default_value_t = 256)]
    max_rows: u32,

    #[arg(long, default_value_t = 2_000)]
    scrollback_lines: usize,

    #[arg(long, default_value_t = 16)]
    max_checkpoint_mebibytes: usize,

    #[arg(long, default_value_t = 512)]
    checkpoint_chunk_kibibytes: usize,

    #[arg(long, default_value_t = 256)]
    client_outbox_frames: usize,

    #[arg(long, default_value_t = 1_024)]
    client_live_outbox_kibibytes: usize,

    #[arg(long, default_value_t = 64)]
    max_input_kibibytes: usize,

    #[arg(long, default_value_t = 512)]
    pty_event_frames: usize,

    #[arg(long)]
    handover: bool,

    #[arg(long)]
    runtime_digest: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    // Default to info rather than the empty filter's ERROR; see the note in pty-vault.rs. The host
    // reads this stream back when a candidate fails to activate.
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
        "pty manager starting"
    );

    let limits = PtyManagerLimits {
        max_sessions: args.max_sessions,
        max_clients_per_session: args.max_clients_per_session,
        max_columns: args.max_columns,
        max_rows: args.max_rows,
        scrollback_lines: args.scrollback_lines,
        max_checkpoint_bytes: checked_scale(args.max_checkpoint_mebibytes, 1024 * 1024)?,
        checkpoint_chunk_bytes: checked_scale(args.checkpoint_chunk_kibibytes, 1024)?,
        client_outbox_frames: args.client_outbox_frames,
        client_live_outbox_bytes: checked_scale(args.client_live_outbox_kibibytes, 1024)?,
        max_input_bytes: checked_scale(args.max_input_kibibytes, 1024)?,
        pty_event_frames: args.pty_event_frames,
    };
    limits.validate()?;
    let socket_path = args.socket;
    let identity_socket_path = socket_path.clone();
    let runtime_digest = args.runtime_digest;
    let publish_identity = move || {
        if let Some(digest) = &runtime_digest {
            pty_manager::runtime_identity::publish(&identity_socket_path, digest)?;
        }
        Ok(())
    };
    let manager = PtyManager::new_configured(
        PtyManagerOptions { socket_path }.with_limits(limits),
    );
    if args.handover {
        manager.run_handover_with_ready(publish_identity).await?;
    } else {
        manager.run_with_ready(publish_identity).await?;
    }
    Ok(())
}

fn checked_scale(value: usize, scale: usize) -> anyhow::Result<usize> {
    value
        .checked_mul(scale)
        .ok_or_else(|| anyhow::anyhow!("PTY manager byte bound overflow"))
}
