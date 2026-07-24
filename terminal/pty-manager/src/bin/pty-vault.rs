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
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();
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
