use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::sync::mpsc::Sender;

use crate::error::{Result, TerminalError};
use crate::fd_transfer::duplicate_descriptor;
use crate::vault_client::{VaultClient, VaultLease};

#[derive(Debug)]
pub enum PtyEvent {
    Output {
        session_name: String,
        generation: u64,
        data: Vec<u8>,
    },
    Exited {
        session_name: String,
        generation: u64,
        status: i32,
    },
}

pub struct PtySession {
    pub name: String,
    pub cwd: String,
    pub shell: String,
    pub pid: u32,
    pub generation: u64,
    master: OwnedFd,
    vault: VaultClient,
    events: Sender<PtyEvent>,
    io: Option<PtyIo>,
    terminal_status: Option<i32>,
}

struct PtyIo {
    input: mpsc::SyncSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
}

impl PtySession {
    pub fn from_vault_lease(
        lease: VaultLease,
        vault: VaultClient,
        events: Sender<PtyEvent>,
    ) -> Result<Self> {
        let session = lease.session;
        let mut pty = Self {
            name: session.name,
            cwd: session.cwd,
            shell: session.shell,
            pid: session.pid,
            generation: session.generation,
            master: lease.descriptor,
            vault,
            events,
            io: None,
            terminal_status: session.exited.then_some(session.exit_status),
        };
        if pty.terminal_status.is_none() {
            pty.resume_io()?;
        }
        Ok(pty)
    }

    pub fn send_input(&self, data: Vec<u8>) -> Result<()> {
        self.io
            .as_ref()
            .ok_or_else(|| TerminalError::Pty("pty lease is quiesced".to_owned()))?
            .input
            .try_send(data)
            .map_err(|error| TerminalError::Pty(format!("pty writer queue unavailable: {error}")))
    }

    pub fn kill(&mut self) -> Result<()> {
        let status = self
            .vault
            .kill(&self.name, self.generation)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        self.terminal_status = Some(status);
        self.quiesce();
        Ok(())
    }

    pub fn resize(&self, columns: u16, rows: u16) -> Result<()> {
        self.vault
            .resize(&self.name, self.generation, columns, rows)
            .map_err(|error| TerminalError::Pty(error.to_string()))
    }

    pub fn wait_status(&mut self) -> i32 {
        if let Some(status) = self.terminal_status {
            return status;
        }
        for _ in 0..100 {
            match self.vault.exit_status(&self.name, self.generation, true) {
                Ok(Some(status)) => {
                    self.terminal_status = Some(status);
                    return status;
                }
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(_) => return -1,
            }
        }
        -1
    }

    pub fn quiesce(&mut self) {
        let Some(mut io) = self.io.take() else {
            return;
        };
        io.stop.store(true, Ordering::Release);
        drop(io.input);
        if let Some(writer) = io.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = io.reader.take() {
            let _ = reader.join();
        }
    }

    pub fn resume_io(&mut self) -> Result<()> {
        if self.io.is_some() {
            return Ok(());
        }
        let reader = File::from(duplicate_descriptor(self.master.as_raw_fd())?);
        let writer = File::from(duplicate_descriptor(self.master.as_raw_fd())?);
        let (input, input_rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let stop = Arc::new(AtomicBool::new(false));
        let reader_thread = spawn_reader(
            self.name.clone(),
            self.generation,
            self.events.clone(),
            reader,
            stop.clone(),
        );
        let writer_thread = spawn_writer(input_rx, writer, stop.clone());
        self.io = Some(PtyIo {
            input,
            stop,
            reader: Some(reader_thread),
            writer: Some(writer_thread),
        });
        Ok(())
    }

    pub fn lease_descriptor(&self) -> &OwnedFd {
        &self.master
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.quiesce();
    }
}

fn spawn_reader(
    session_name: String,
    generation: u64,
    events: Sender<PtyEvent>,
    mut reader: File,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while !stop.load(Ordering::Acquire) {
            match poll_descriptor(reader.as_raw_fd(), libc::POLLIN, &stop) {
                Ok(false) => continue,
                Err(_) => break,
                Ok(true) => {}
            }
            match reader.read(&mut buffer) {
                Ok(0) => {
                    send_exit(&events, &session_name, generation);
                    break;
                }
                Ok(count) => {
                    if events
                        .blocking_send(PtyEvent::Output {
                            session_name: session_name.clone(),
                            generation,
                            data: buffer[..count].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.raw_os_error() == Some(libc::EIO) => {
                    send_exit(&events, &session_name, generation);
                    break;
                }
                Err(_) => {
                    send_exit(&events, &session_name, generation);
                    break;
                }
            }
        }
    })
}

fn spawn_writer(
    input_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: File,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            let data = match input_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(data) => data,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut remaining = data.as_slice();
            while !remaining.is_empty() && !stop.load(Ordering::Acquire) {
                match poll_descriptor(writer.as_raw_fd(), libc::POLLOUT, &stop) {
                    Ok(false) => continue,
                    Err(_) => return,
                    Ok(true) => {}
                }
                match writer.write(remaining) {
                    Ok(0) => return,
                    Ok(count) => remaining = &remaining[count..],
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => return,
                }
            }
            if writer.flush().is_err() {
                break;
            }
        }
    })
}

fn poll_descriptor(descriptor: i32, events: i16, stop: &AtomicBool) -> std::io::Result<bool> {
    let mut poll = libc::pollfd {
        fd: descriptor,
        events,
        revents: 0,
    };
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        let ready = unsafe { libc::poll(&mut poll, 1, 50) };
        if ready > 0 {
            return Ok(true);
        }
        if ready == 0 {
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn send_exit(events: &Sender<PtyEvent>, session_name: &str, generation: u64) {
    let _ = events.blocking_send(PtyEvent::Exited {
        session_name: session_name.to_owned(),
        generation,
        status: -1,
    });
}
