use std::collections::VecDeque;
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
use crate::vault_protocol::generated::Session;

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
    metadata: Session,
    pending_input: VecDeque<Vec<u8>>,
}

struct PtyIo {
    input: mpsc::SyncSender<Vec<u8>>,
    start: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<Option<PtyEvent>>>,
    writer: Option<JoinHandle<()>>,
}

impl PtySession {
    pub fn from_vault_lease(
        lease: VaultLease,
        vault: VaultClient,
        events: Sender<PtyEvent>,
    ) -> Result<Self> {
        let mut pty = Self::from_vault_lease_quiesced(lease, vault, events)?;
        if pty.terminal_status.is_none() {
            pty.resume_io()?;
        }
        Ok(pty)
    }

    pub fn from_vault_lease_quiesced(
        lease: VaultLease,
        vault: VaultClient,
        events: Sender<PtyEvent>,
    ) -> Result<Self> {
        let session = lease.session;
        Ok(Self {
            name: session.name.clone(),
            cwd: session.cwd.clone(),
            shell: session.shell.clone(),
            pid: session.pid,
            generation: session.generation,
            master: lease.descriptor,
            vault,
            events,
            io: None,
            terminal_status: session.exited.then_some(session.exit_status),
            metadata: session,
            pending_input: VecDeque::new(),
        })
    }

    pub fn send_input(&mut self, data: Vec<u8>) -> Result<()> {
        let Some(io) = &self.io else {
            return self.queue_pending_input(data);
        };
        io.input
            .try_send(data)
            .map_err(|error| TerminalError::Pty(format!("pty writer queue unavailable: {error}")))
    }

    pub fn kill(&mut self) -> Result<()> {
        let status = self
            .vault
            .kill(&self.name, self.generation)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        self.terminal_status = Some(status);
        let _ = self.quiesce();
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

    pub fn quiesce(&mut self) -> Vec<PtyEvent> {
        let Some(mut io) = self.io.take() else {
            return Vec::new();
        };
        io.stop.store(true, Ordering::Release);
        drop(io.input);
        if let Some(writer) = io.writer.take() {
            let _ = writer.join();
        }
        io.reader
            .take()
            .and_then(|reader| reader.join().ok().flatten())
            .into_iter()
            .collect()
    }

    pub fn resume_io(&mut self) -> Result<()> {
        self.prepare_io()?;
        self.activate_io();
        Ok(())
    }

    pub fn prepare_io(&mut self) -> Result<()> {
        if self.io.is_some() {
            return Ok(());
        }
        let reader = File::from(duplicate_descriptor(self.master.as_raw_fd())?);
        let writer = File::from(duplicate_descriptor(self.master.as_raw_fd())?);
        let (input, input_rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let start = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let reader_thread = spawn_reader(
            self.name.clone(),
            self.generation,
            self.events.clone(),
            reader,
            start.clone(),
            stop.clone(),
        );
        let writer_thread = spawn_writer(input_rx, writer, start.clone(), stop.clone());
        self.io = Some(PtyIo {
            input,
            start,
            stop,
            reader: Some(reader_thread),
            writer: Some(writer_thread),
        });
        let pending = std::mem::take(&mut self.pending_input);
        for data in pending {
            self.io
                .as_ref()
                .expect("PTY I/O was just installed")
                .input
                .try_send(data)
                .map_err(|error| {
                    TerminalError::Pty(format!("pending PTY input restore failed: {error}"))
                })?;
        }
        Ok(())
    }

    pub fn activate_io(&self) {
        if let Some(io) = &self.io {
            io.start.store(true, Ordering::Release);
        }
    }

    pub fn lease_descriptor(&self) -> &OwnedFd {
        &self.master
    }

    pub fn vault_metadata(&self, lifetime: i32, columns: u32, rows: u32) -> Session {
        let mut metadata = self.metadata.clone();
        metadata.lifetime = lifetime;
        metadata.columns = columns;
        metadata.rows = rows;
        metadata
    }

    pub fn pending_input(&self) -> Vec<Vec<u8>> {
        self.pending_input.iter().cloned().collect()
    }

    pub fn restore_pending_input(&mut self, pending: Vec<Vec<u8>>) -> Result<()> {
        for data in pending {
            self.queue_pending_input(data)?;
        }
        Ok(())
    }

    fn queue_pending_input(&mut self, data: Vec<u8>) -> Result<()> {
        const MAX_PENDING_FRAMES: usize = 16;
        const MAX_PENDING_BYTES: usize = 1024 * 1024;
        let pending_bytes = self.pending_input.iter().map(Vec::len).sum::<usize>();
        if self.pending_input.len() >= MAX_PENDING_FRAMES
            || pending_bytes
                .checked_add(data.len())
                .is_none_or(|total| total > MAX_PENDING_BYTES)
        {
            return Err(TerminalError::Pty(
                "pending PTY input exceeds handover bound".to_owned(),
            ));
        }
        self.pending_input.push_back(data);
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.quiesce();
    }
}

fn spawn_reader(
    session_name: String,
    generation: u64,
    events: Sender<PtyEvent>,
    mut reader: File,
    start: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<Option<PtyEvent>> {
    thread::spawn(move || {
        while !start.load(Ordering::Acquire) {
            if stop.load(Ordering::Acquire) {
                return None;
            }
            thread::sleep(Duration::from_millis(1));
        }
        let mut buffer = [0_u8; 8192];
        while !stop.load(Ordering::Acquire) {
            match poll_descriptor(reader.as_raw_fd(), libc::POLLIN, &stop) {
                Ok(false) => continue,
                Err(_) => break,
                Ok(true) => {}
            }
            match reader.read(&mut buffer) {
                Ok(0) => {
                    return send_exit(&events, &session_name, generation, &stop);
                }
                Ok(count) => {
                    if let Some(event) = send_event(
                        &events,
                        PtyEvent::Output {
                            session_name: session_name.clone(),
                            generation,
                            data: buffer[..count].to_vec(),
                        },
                        &stop,
                    ) {
                        return Some(event);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.raw_os_error() == Some(libc::EIO) => {
                    return send_exit(&events, &session_name, generation, &stop);
                }
                Err(_) => {
                    return send_exit(&events, &session_name, generation, &stop);
                }
            }
        }
        None
    })
}

fn spawn_writer(
    input_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: File,
    start: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !start.load(Ordering::Acquire) {
            if stop.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(Duration::from_millis(1));
        }
        while let Ok(data) = input_rx.recv() {
            let mut remaining = data.as_slice();
            while !remaining.is_empty() {
                if poll_descriptor_until_ready(writer.as_raw_fd(), libc::POLLOUT).is_err() {
                    return;
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

fn poll_descriptor_until_ready(descriptor: i32, events: i16) -> std::io::Result<()> {
    let never_stop = AtomicBool::new(false);
    while !poll_descriptor(descriptor, events, &never_stop)? {}
    Ok(())
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

fn send_exit(
    events: &Sender<PtyEvent>,
    session_name: &str,
    generation: u64,
    stop: &AtomicBool,
) -> Option<PtyEvent> {
    send_event(
        events,
        PtyEvent::Exited {
            session_name: session_name.to_owned(),
            generation,
            status: -1,
        },
        stop,
    )
}

fn send_event(
    events: &Sender<PtyEvent>,
    mut event: PtyEvent,
    stop: &AtomicBool,
) -> Option<PtyEvent> {
    loop {
        if stop.load(Ordering::Acquire) {
            return Some(event);
        }
        match events.try_send(event) {
            Ok(()) => return None,
            Err(tokio::sync::mpsc::error::TrySendError::Full(returned)) => {
                event = returned;
                thread::sleep(Duration::from_millis(1));
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return None,
        }
    }
}
