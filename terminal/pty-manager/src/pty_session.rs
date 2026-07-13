use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::UnboundedSender;

use crate::error::{Result, TerminalError};

#[derive(Debug)]
pub enum PtyEvent {
    Output { session_name: String, data: Vec<u8> },
    Exited { session_name: String, status: i32 },
}

pub enum PtyLaunch {
    Shell {
        cwd: PathBuf,
        shell: String,
    },
    Command {
        cwd: PathBuf,
        executable: String,
        arguments: Vec<String>,
    },
}

pub struct PtySession {
    pub name: String,
    pub cwd: String,
    pub shell: String,
    pub pid: u32,
    input: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    pub fn spawn(
        name: impl Into<String>,
        launch: PtyLaunch,
        columns: u16,
        rows: u16,
        events: UnboundedSender<PtyEvent>,
    ) -> Result<Self> {
        let name = name.into();
        let (cwd, shell, mut command) = match launch {
            PtyLaunch::Shell { cwd, shell } => {
                let mut command = CommandBuilder::new_default_prog();
                command.env("SHELL", &shell);
                (cwd, shell, command)
            }
            PtyLaunch::Command {
                cwd,
                executable,
                arguments,
            } => {
                let mut command = CommandBuilder::new(&executable);
                command.args(arguments);
                (cwd, executable, command)
            }
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))?;

        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "agentdesk");
        command.env("PTY_SESSION", &name);

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let pid = child.process_id().unwrap_or_default();

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let (input, input_rx) = mpsc::channel::<Vec<u8>>();

        spawn_reader(name.clone(), &events, &mut reader);
        spawn_writer(input_rx, &mut writer);

        Ok(Self {
            name,
            cwd: cwd.to_string_lossy().into_owned(),
            shell,
            pid,
            input,
            master: pair.master,
            child,
        })
    }

    pub fn send_input(&self, data: Vec<u8>) -> Result<()> {
        self.input
            .send(data)
            .map_err(|_| TerminalError::Pty("pty writer thread exited".to_owned()))
    }

    pub fn kill(&mut self) -> Result<()> {
        self.child
            .kill()
            .map_err(|error| TerminalError::Pty(error.to_string()))
    }

    pub fn resize(&self, columns: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))
    }

    pub fn wait_status(&mut self) -> i32 {
        match self.child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        }
    }
}

fn spawn_reader(
    session_name: String,
    events: &UnboundedSender<PtyEvent>,
    reader: &mut Box<dyn Read + Send>,
) {
    let events = events.clone();
    let mut reader = std::mem::replace(reader, Box::new(std::io::empty()));
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(PtyEvent::Exited {
                        session_name: session_name.clone(),
                        status: 0,
                    });
                    break;
                }
                Ok(count) => {
                    let _ = events.send(PtyEvent::Output {
                        session_name: session_name.clone(),
                        data: buffer[..count].to_vec(),
                    });
                }
                Err(_) => {
                    let _ = events.send(PtyEvent::Exited {
                        session_name: session_name.clone(),
                        status: -1,
                    });
                    break;
                }
            }
        }
    });
}

fn spawn_writer(input_rx: mpsc::Receiver<Vec<u8>>, writer: &mut Box<dyn Write + Send>) {
    let mut writer = std::mem::replace(writer, Box::new(std::io::sink()));
    thread::spawn(move || {
        while let Ok(data) = input_rx.recv() {
            if writer.write_all(&data).is_err() {
                break;
            }
            if writer.flush().is_err() {
                break;
            }
        }
    });
}
