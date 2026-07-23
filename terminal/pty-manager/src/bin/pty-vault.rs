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
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();
    Vault::new(VaultOptions {
        socket_path: args.socket,
        max_sessions: args.max_sessions,
    })?
    .run()?;
    Ok(())
}
