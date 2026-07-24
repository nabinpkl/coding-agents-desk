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
use crate::runtime_config::pending_input_limits;
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
    writer: Option<JoinHandle<Vec<Vec<u8>>>>,
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
            if let Ok(pending) = writer.join() {
                self.pending_input.extend(pending);
            }
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
        let pending_input_limits = pending_input_limits()?;
        let (input, input_rx) =
            mpsc::sync_channel::<Vec<u8>>(pending_input_limits.frames.saturating_sub(1));
        let start = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let initial_input = std::mem::take(&mut self.pending_input);
        let reader_thread = spawn_reader(
            self.name.clone(),
            self.generation,
            self.events.clone(),
            reader,
            start.clone(),
            stop.clone(),
        );
        let writer_thread =
            spawn_writer(initial_input, input_rx, writer, start.clone(), stop.clone());
        self.io = Some(PtyIo {
            input,
            start,
            stop,
            reader: Some(reader_thread),
            writer: Some(writer_thread),
        });
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
        let limits = pending_input_limits()?;
        let pending_bytes = self.pending_input.iter().map(Vec::len).sum::<usize>();
        if self.pending_input.len() >= limits.frames
            || pending_bytes
                .checked_add(data.len())
                .is_none_or(|total| total > limits.bytes)
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
    mut initial_input: VecDeque<Vec<u8>>,
    input_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: File,
    start: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<Vec<Vec<u8>>> {
    thread::spawn(move || {
        while !start.load(Ordering::Acquire) {
            if stop.load(Ordering::Acquire) {
                return initial_input
                    .into_iter()
                    .chain(input_rx.try_iter())
                    .collect();
            }
            thread::sleep(Duration::from_millis(1));
        }
        loop {
            let data = match initial_input.pop_front() {
                Some(data) => data,
                None => match input_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(data) => data,
                    Err(mpsc::RecvTimeoutError::Timeout) if stop.load(Ordering::Acquire) => {
                        return input_rx.try_iter().collect();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Vec::new(),
                },
            };
            let mut remaining = data.as_slice();
            while !remaining.is_empty() {
                match poll_descriptor(writer.as_raw_fd(), libc::POLLOUT, &stop) {
                    Ok(true) => {}
                    Ok(false) if stop.load(Ordering::Acquire) => {
                        return pending_writer_input(remaining, initial_input, &input_rx);
                    }
                    Ok(false) => continue,
                    Err(_) => return pending_writer_input(remaining, initial_input, &input_rx),
                }
                match writer.write(remaining) {
                    Ok(0) => return pending_writer_input(remaining, initial_input, &input_rx),
                    Ok(count) => remaining = &remaining[count..],
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => return pending_writer_input(remaining, initial_input, &input_rx),
                }
            }
            if writer.flush().is_err() {
                return initial_input
                    .into_iter()
                    .chain(input_rx.try_iter())
                    .collect();
            }
        }
    })
}

fn pending_writer_input(
    remaining: &[u8],
    initial_input: VecDeque<Vec<u8>>,
    input_rx: &mpsc::Receiver<Vec<u8>>,
) -> Vec<Vec<u8>> {
    std::iter::once(remaining.to_vec())
        .chain(initial_input)
        .chain(input_rx.try_iter())
        .collect()
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

#[cfg(test)]
mod tests {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::time::Instant;

    use super::*;

    #[test]
    fn writer_quiesce_returns_backpressured_input_without_blocking() {
        let (writer_descriptor, _reader_descriptor) = socket_pair();
        fill_socket_send_buffer(writer_descriptor.as_raw_fd());
        set_nonblocking(writer_descriptor.as_raw_fd(), false);

        let limits = pending_input_limits().expect("pending input limits");
        let (input, input_rx) = mpsc::sync_channel(limits.frames.saturating_sub(1));
        let start = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let writer = spawn_writer(
            VecDeque::new(),
            input_rx,
            File::from(writer_descriptor),
            start,
            stop.clone(),
        );
        let frames = (0..limits.frames)
            .map(|index| format!("preserve-{index}").into_bytes())
            .collect::<Vec<_>>();
        input
            .send(frames[0].clone())
            .expect("queue in-flight writer input");
        thread::sleep(Duration::from_millis(75));
        for frame in frames.iter().skip(1) {
            input
                .send(frame.clone())
                .expect("fill pending writer queue");
        }

        let started = Instant::now();
        stop.store(true, Ordering::Release);
        drop(input);
        let pending = writer.join().expect("join writer");

        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(pending, frames);
        assert!(pending.iter().map(Vec::len).sum::<usize>() <= limits.bytes);
    }

    #[test]
    fn writer_preparation_accepts_full_handover_input_bound() {
        let (writer_descriptor, _reader_descriptor) = socket_pair();
        let limits = pending_input_limits().expect("pending input limits");
        let initial_input = (0..limits.frames)
            .map(|index| format!("restore-{index}").into_bytes())
            .collect::<VecDeque<_>>();
        let expected = initial_input.iter().cloned().collect::<Vec<_>>();
        let (_input, input_rx) = mpsc::sync_channel(limits.frames.saturating_sub(1));
        let start = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let writer = spawn_writer(
            initial_input,
            input_rx,
            File::from(writer_descriptor),
            start,
            stop.clone(),
        );

        stop.store(true, Ordering::Release);
        assert_eq!(writer.join().expect("join prepared writer"), expected);
    }

    fn socket_pair() -> (OwnedFd, OwnedFd) {
        let mut descriptors = [-1; 2];
        let result = unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_STREAM,
                0,
                descriptors.as_mut_ptr(),
            )
        };
        assert_eq!(result, 0, "create socket pair");
        unsafe {
            (
                OwnedFd::from_raw_fd(descriptors[0]),
                OwnedFd::from_raw_fd(descriptors[1]),
            )
        }
    }

    fn fill_socket_send_buffer(descriptor: i32) {
        set_nonblocking(descriptor, true);
        let buffer = [0_u8; 8_192];
        loop {
            let written = unsafe { libc::write(descriptor, buffer.as_ptr().cast(), buffer.len()) };
            if written >= 0 {
                continue;
            }
            let error = std::io::Error::last_os_error();
            assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
            break;
        }
    }

    fn set_nonblocking(descriptor: i32, enabled: bool) {
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        assert!(flags >= 0, "read descriptor flags");
        let flags = if enabled {
            flags | libc::O_NONBLOCK
        } else {
            flags & !libc::O_NONBLOCK
        };
        assert_eq!(
            unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags) },
            0,
            "write descriptor flags"
        );
    }
}
