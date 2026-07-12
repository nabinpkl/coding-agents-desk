use std::path::PathBuf;

use clap::Parser;
use pty_manager::manager::{PtyManager, PtyManagerOptions};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "/tmp/pty-manager.sock")]
    socket: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();

    PtyManager::new(PtyManagerOptions {
        socket_path: args.socket,
    })
    .run()
    .await?;
    Ok(())
}
