use std::path::PathBuf;

use clap::Parser;
use pty_manager::client::list_sessions;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "/tmp/pty-manager.sock")]
    socket: PathBuf,

    #[arg(long)]
    sessions_only: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let sessions = list_sessions(&args.socket).await?;

    if !args.sessions_only {
        println!();
    }

    for session in sessions {
        if args.sessions_only {
            println!("{}", session.name);
        } else {
            println!(
                "{}\tpid={}\tclients={}\tcwd={}\tshell={}",
                session.name,
                session.pid,
                session.clients.len(),
                session.cwd,
                session.shell
            );
        }
    }

    Ok(())
}
