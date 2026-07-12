use std::io::{self, IsTerminal, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use clap::Parser;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, size as terminal_size};
use futures_util::{SinkExt, StreamExt};
use pty_manager::client::{connect, kill_session, next_numeric_session_name};
use pty_manager::protocol::{self, CreateOrAttach, Detach, Input, Payload, Resize};
use pty_manager::pty_client_footer::{child_pty_rows, FooterRenderer, FooterState, TerminalSize};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "/tmp/pty-manager.sock")]
    socket: PathBuf,

    #[arg(long)]
    session: Option<String>,

    #[arg(long)]
    kill_session: Option<String>,

    #[arg(long, default_value = ".")]
    cwd: PathBuf,

    #[arg(long)]
    shell: Option<String>,

    #[arg(long, default_value_t = 120)]
    cols: u32,

    #[arg(long, default_value_t = 40)]
    rows: u32,

    #[arg(long)]
    no_footer: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    if let Some(session_name) = args.kill_session.as_deref() {
        let status = kill_session(&args.socket, session_name).await?;
        eprintln!("killed terminal session {session_name}: {status}");
        return Ok(());
    }

    let session_name = match args.session {
        Some(session) => session,
        None => next_numeric_session_name(&args.socket).await?,
    };
    run_client(
        args.socket,
        session_name,
        args.cwd,
        args.shell,
        args.cols,
        args.rows,
        args.no_footer,
    )
    .await
}

async fn run_client(
    socket_path: PathBuf,
    session_name: String,
    cwd: PathBuf,
    shell: Option<String>,
    cols: u32,
    rows: u32,
    no_footer: bool,
) -> anyhow::Result<()> {
    let shell = shell.unwrap_or_else(default_shell);
    let mut framed = connect(&socket_path).await?;
    let cwd = cwd.canonicalize().unwrap_or(cwd);
    let (footer_mode, initial_terminal_size, attach_columns, attach_rows) =
        prepare_terminal_mode(cols, rows, no_footer)?;

    pty_manager::transport::send(
        &mut framed,
        &protocol::envelope(
            1,
            &session_name,
            Payload::CreateOrAttach(CreateOrAttach {
                cwd: cwd.to_string_lossy().into_owned(),
                shell,
                columns: attach_columns,
                rows: attach_rows,
                create_if_missing: true,
                client_title: "pty-client".to_owned(),
            }),
        ),
    )
    .await?;

    let (mut writer, mut reader) = framed.split();
    let session_for_reader = session_name.clone();
    let footer_for_reader = footer_mode.clone();
    let mut reader_task = tokio::spawn(async move {
        let mut attached_to_session = false;
        while let Some(frame) = reader.next().await {
            let frame = frame?;
            let envelope = protocol::decode(&frame)?;
            match protocol::payload(envelope)? {
                Payload::Attached(attached) => {
                    attached_to_session = true;
                    if let Some(footer) = footer_for_reader.as_ref() {
                        *footer.state.lock().await = Some(FooterState {
                            session_name: session_for_reader.clone(),
                            pid: attached.pid,
                            client_count: attached.client_count,
                            shell: attached.shell,
                            cwd: attached.cwd,
                        });
                        redraw_footer(footer).await?;
                    } else {
                        eprintln!(
                            "\n[pty session attached: {} pid={} shell={} cwd={}]",
                            session_for_reader, attached.pid, attached.shell, attached.cwd
                        );
                    }
                }
                Payload::Output(output) => {
                    io::stdout().write_all(&output.data)?;
                    io::stdout().flush()?;
                    if let Some(footer) = footer_for_reader.as_ref() {
                        redraw_footer(footer).await?;
                    }
                }
                Payload::SessionExited(exited) => {
                    eprintln!("\n[terminal session exited: {}]", exited.status);
                    break;
                }
                Payload::ClientDetached(_) => {
                    eprintln!("\n[pty client detached by manager]");
                    break;
                }
                Payload::Error(error) => {
                    anyhow::bail!(error.message);
                }
                _ => {}
            }
        }
        if !attached_to_session {
            anyhow::bail!("pty manager closed before attaching session");
        }
        Ok::<(), anyhow::Error>(())
    });

    let session_for_input = session_name.clone();
    let footer_for_input = footer_mode.clone();
    let mut input_task = tokio::spawn(async move {
        let raw_mode = RawMode::enter();
        let client_events = spawn_client_events(initial_terminal_size);
        let result = forward_client_events(
            &mut writer,
            &session_for_input,
            client_events,
            footer_for_input,
        )
        .await;
        drop(raw_mode);
        result
    });

    let result = tokio::select! {
        reader_result = &mut reader_task => {
            input_task.abort();
            reader_result?
        }
        input_result = &mut input_task => {
            let result = input_result?;
            reader_task.abort();
            result
        }
    };

    let restore_result = match footer_mode.as_ref() {
        Some(footer) => restore_footer(footer).await,
        None => Ok(()),
    };
    result?;
    restore_result?;
    Ok(())
}

fn prepare_terminal_mode(
    fallback_columns: u32,
    fallback_rows: u32,
    no_footer: bool,
) -> anyhow::Result<(Option<FooterMode>, Option<TerminalSize>, u32, u32)> {
    if !(io::stdin().is_terminal() && io::stdout().is_terminal()) {
        return Ok((None, None, fallback_columns, fallback_rows));
    }

    let size = current_terminal_size()?;
    if no_footer {
        return Ok((
            None,
            Some(size),
            u32::from(size.columns),
            u32::from(size.rows),
        ));
    }

    let child_rows = child_pty_rows(size)?;
    let mut renderer = FooterRenderer::new(size)?;
    renderer.activate()?;
    Ok((
        Some(FooterMode {
            renderer: Arc::new(Mutex::new(renderer)),
            state: Arc::new(Mutex::new(None)),
        }),
        Some(size),
        u32::from(size.columns),
        u32::from(child_rows),
    ))
}

fn spawn_client_events(initial_size: Option<TerminalSize>) -> mpsc::UnboundedReceiver<ClientEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    let input_tx = tx.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buffer = [0_u8; 8192];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => {
                    let _ = input_tx.send(ClientEvent::Input(Ok(Vec::new())));
                    break;
                }
                Ok(count) => {
                    if input_tx
                        .send(ClientEvent::Input(Ok(buffer[..count].to_vec())))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = input_tx.send(ClientEvent::Input(Err(error)));
                    break;
                }
            }
        }
    });

    if let Some(size) = initial_size {
        spawn_resize_watcher(tx, size);
    }

    rx
}

fn spawn_resize_watcher(tx: mpsc::UnboundedSender<ClientEvent>, initial_size: TerminalSize) {
    thread::spawn(move || {
        let mut last_size = initial_size;
        while !tx.is_closed() {
            thread::sleep(Duration::from_millis(200));
            match current_terminal_size() {
                Ok(size) if size != last_size => {
                    last_size = size;
                    if tx.send(ClientEvent::Resize(Ok(size))).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = tx.send(ClientEvent::Resize(Err(error)));
                    break;
                }
            }
        }
    });
}

async fn forward_client_events(
    writer: &mut futures_util::stream::SplitSink<
        pty_manager::transport::TerminalFramed,
        bytes::Bytes,
    >,
    session_name: &str,
    mut events: mpsc::UnboundedReceiver<ClientEvent>,
    footer: Option<FooterMode>,
) -> anyhow::Result<()> {
    while let Some(event) = events.recv().await {
        match event {
            ClientEvent::Input(read) => {
                if forward_input_buffer(writer, session_name, read?).await? {
                    return Ok(());
                }
            }
            ClientEvent::Resize(read) => {
                let size = read?;
                if let Some(footer) = footer.as_ref() {
                    let child_rows = resize_footer(footer, size).await?;
                    send_resize(writer, session_name, size.columns, child_rows).await?;
                } else {
                    send_resize(writer, session_name, size.columns, size.rows).await?;
                };
            }
        }
    }
    Ok(())
}

async fn forward_input_buffer(
    writer: &mut futures_util::stream::SplitSink<
        pty_manager::transport::TerminalFramed,
        bytes::Bytes,
    >,
    session_name: &str,
    buffer: Vec<u8>,
) -> anyhow::Result<bool> {
    if buffer.is_empty() {
        send_detach(writer, session_name).await?;
        return Ok(true);
    }

    if let Some(detach_index) = buffer.iter().position(|byte| *byte == 0x1d) {
        if detach_index > 0 {
            send_input(writer, session_name, buffer[..detach_index].to_vec()).await?;
        }
        send_detach(writer, session_name).await?;
        return Ok(true);
    }

    send_input(writer, session_name, buffer).await?;
    Ok(false)
}

async fn send_detach(
    writer: &mut futures_util::stream::SplitSink<
        pty_manager::transport::TerminalFramed,
        bytes::Bytes,
    >,
    session_name: &str,
) -> anyhow::Result<()> {
    writer
        .send(pty_manager::protocol::encode(&protocol::envelope(
            2,
            session_name,
            Payload::Detach(Detach {}),
        ))?)
        .await?;
    Ok(())
}

async fn send_input(
    writer: &mut futures_util::stream::SplitSink<
        pty_manager::transport::TerminalFramed,
        bytes::Bytes,
    >,
    session_name: &str,
    data: Vec<u8>,
) -> anyhow::Result<()> {
    writer
        .send(pty_manager::protocol::encode(&protocol::envelope(
            2,
            session_name,
            Payload::Input(Input { data }),
        ))?)
        .await?;
    Ok(())
}

async fn send_resize(
    writer: &mut futures_util::stream::SplitSink<
        pty_manager::transport::TerminalFramed,
        bytes::Bytes,
    >,
    session_name: &str,
    columns: u16,
    rows: u16,
) -> anyhow::Result<()> {
    writer
        .send(pty_manager::protocol::encode(&protocol::envelope(
            2,
            session_name,
            Payload::Resize(Resize {
                columns: u32::from(columns),
                rows: u32::from(rows),
            }),
        ))?)
        .await?;
    Ok(())
}

async fn redraw_footer(footer: &FooterMode) -> anyhow::Result<()> {
    let state = footer.state.lock().await.clone();
    let Some(state) = state else {
        return Ok(());
    };
    footer.renderer.lock().await.draw(&state)
}

async fn resize_footer(footer: &FooterMode, size: TerminalSize) -> anyhow::Result<u16> {
    let child_rows = child_pty_rows(size)?;
    footer.renderer.lock().await.resize(size)?;
    redraw_footer(footer).await?;
    Ok(child_rows)
}

async fn restore_footer(footer: &FooterMode) -> anyhow::Result<()> {
    footer.renderer.lock().await.restore()
}

fn current_terminal_size() -> io::Result<TerminalSize> {
    let (columns, rows) = terminal_size()?;
    Ok(TerminalSize { columns, rows })
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
}

#[derive(Clone)]
struct FooterMode {
    renderer: Arc<Mutex<FooterRenderer>>,
    state: Arc<Mutex<Option<FooterState>>>,
}

enum ClientEvent {
    Input(io::Result<Vec<u8>>),
    Resize(io::Result<TerminalSize>),
}

struct RawMode {
    enabled: bool,
}

impl RawMode {
    fn enter() -> Self {
        let enabled = io::stdin().is_terminal() && enable_raw_mode().is_ok();
        Self { enabled }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if self.enabled {
            let _ = disable_raw_mode();
        }
    }
}
