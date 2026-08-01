use std::collections::HashSet;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use prost::Message;

use crate::error::{Result, TerminalError};
use crate::fd_transfer::{receive_message, send_message};
use crate::handover_common::{
    checksum, configure_stream, expect_phase, send_phase, validate_same_euid_peer,
};
use crate::manager_handover_protocol::generated::{
    ManagerHandoverCommit, ManagerHandoverDescriptor, ManagerHandoverListener,
    ManagerHandoverManifest, ManagerSessionState,
};
use crate::manager_handover_protocol::MANAGER_HANDOVER_PROTOCOL_VERSION;
use crate::protocol::validate_session_name;
use crate::runtime_config::pending_input_limits;
use crate::vault_protocol::generated::handover_phase;

pub(crate) struct ManagerSnapshot {
    pub(crate) sessions: Vec<ManagerSessionState>,
    pub(crate) descriptors: Vec<OwnedFd>,
}

pub(crate) struct ReceivedManagerHandover {
    pub(crate) public_listener: UnixListener,
    pub(crate) handover_listener: UnixListener,
    pub(crate) sessions: Vec<(ManagerSessionState, OwnedFd)>,
    pub(crate) manager_generation: u64,
    control: UnixStream,
}

impl ReceivedManagerHandover {
    pub(crate) fn activate(&mut self) -> Result<()> {
        send_phase(&mut self.control, handover_phase::Phase::Active)
    }

    pub(crate) fn into_listeners(self) -> (UnixListener, UnixListener) {
        (self.public_listener, self.handover_listener)
    }
}

pub(crate) fn send_handover(
    mut control: UnixStream,
    public_listener: i32,
    handover_listener: i32,
    manager_generation: u64,
    snapshot: ManagerSnapshot,
) -> Result<()> {
    validate_same_euid_peer(&control, "manager")?;
    configure_stream(&control)?;
    let next_generation = manager_generation
        .checked_add(1)
        .ok_or_else(|| TerminalError::Protocol("manager generation overflow".to_owned()))?;
    let checksum = manager_checksum(next_generation, &snapshot.sessions);
    send_message(
        &mut control,
        &ManagerHandoverManifest {
            protocol_version: MANAGER_HANDOVER_PROTOCOL_VERSION,
            manager_generation: next_generation,
            session_count: snapshot.sessions.len() as u32,
            checksum,
            sessions: snapshot.sessions.clone(),
        },
        Some(public_listener),
    )?;
    send_message(
        &mut control,
        &ManagerHandoverListener {
            protocol_version: MANAGER_HANDOVER_PROTOCOL_VERSION,
        },
        Some(handover_listener),
    )?;
    for (index, (session, descriptor)) in snapshot
        .sessions
        .iter()
        .zip(snapshot.descriptors)
        .enumerate()
    {
        let identity = session.vault_session.as_ref().ok_or_else(|| {
            TerminalError::Protocol("manager snapshot omitted vault identity".to_owned())
        })?;
        send_message(
            &mut control,
            &ManagerHandoverDescriptor {
                index: index as u32,
                session_name: identity.name.clone(),
                session_generation: identity.generation,
            },
            Some(descriptor.as_raw_fd()),
        )?;
    }
    expect_phase(&mut control, handover_phase::Phase::Ready, "manager")?;
    send_message(
        &mut control,
        &ManagerHandoverCommit {
            manager_generation: next_generation,
            checksum,
        },
        None,
    )?;
    expect_phase(&mut control, handover_phase::Phase::Active, "manager")
}

pub(crate) fn receive_handover(
    manager_socket_path: &Path,
    max_sessions: usize,
) -> Result<ReceivedManagerHandover> {
    let mut control = UnixStream::connect(manager_handover_socket_path(manager_socket_path))?;
    configure_stream(&control)?;
    let (manifest, public_descriptor) = receive_message::<ManagerHandoverManifest>(&mut control)?;
    validate_manifest(&manifest, max_sessions)?;
    let public_descriptor = public_descriptor.ok_or_else(|| {
        TerminalError::Protocol("manager handover omitted public listener".to_owned())
    })?;
    let (listener_frame, handover_descriptor) =
        receive_message::<ManagerHandoverListener>(&mut control)?;
    if listener_frame.protocol_version != MANAGER_HANDOVER_PROTOCOL_VERSION {
        return Err(TerminalError::Protocol(
            "manager handover listener version mismatch".to_owned(),
        ));
    }
    let handover_descriptor = handover_descriptor.ok_or_else(|| {
        TerminalError::Protocol("manager handover omitted private listener".to_owned())
    })?;
    let mut sessions = Vec::with_capacity(manifest.sessions.len());
    for (index, session) in manifest.sessions.iter().enumerate() {
        let identity = session.vault_session.as_ref().ok_or_else(|| {
            TerminalError::Protocol("manager handover omitted session identity".to_owned())
        })?;
        let (descriptor_frame, descriptor) =
            receive_message::<ManagerHandoverDescriptor>(&mut control)?;
        if descriptor_frame.index != index as u32
            || descriptor_frame.session_name != identity.name
            || descriptor_frame.session_generation != identity.generation
        {
            return Err(TerminalError::Protocol(
                "manager handover descriptor manifest mismatch".to_owned(),
            ));
        }
        sessions.push((
            session.clone(),
            descriptor.ok_or_else(|| {
                TerminalError::Protocol("manager handover omitted PTY lease".to_owned())
            })?,
        ));
    }
    send_phase(&mut control, handover_phase::Phase::Ready)?;
    let (commit, descriptor) = receive_message::<ManagerHandoverCommit>(&mut control)?;
    if descriptor.is_some()
        || commit.manager_generation != manifest.manager_generation
        || commit.checksum != manifest.checksum
    {
        return Err(TerminalError::Protocol(
            "manager handover commit mismatch".to_owned(),
        ));
    }
    let public_listener = UnixListener::from(public_descriptor);
    public_listener.set_nonblocking(true)?;
    let handover_listener = UnixListener::from(handover_descriptor);
    handover_listener.set_nonblocking(true)?;
    Ok(ReceivedManagerHandover {
        public_listener,
        handover_listener,
        sessions,
        manager_generation: manifest.manager_generation,
        control,
    })
}

pub(crate) fn manager_handover_socket_path(manager_socket_path: &Path) -> PathBuf {
    let file_name = manager_socket_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pty-manager.sock");
    manager_socket_path.with_file_name(format!("{file_name}.handover"))
}

fn validate_manifest(manifest: &ManagerHandoverManifest, max_sessions: usize) -> Result<()> {
    let pending_input_limits = pending_input_limits()?;
    // The manifest checksum is deliberately not recomputed here. It is a hash of re-encoded
    // protobuf, and prost drops fields the reader does not know, so a candidate built from a
    // different schema re-encodes different bytes and fails a transfer in which nothing went
    // wrong. That is the failure that stranded the runtime under ADR-0078's field removal.
    // Identity, counts, and the per-descriptor frame cross-check below carry the real validation.
    if manifest.protocol_version != MANAGER_HANDOVER_PROTOCOL_VERSION
        || manifest.manager_generation == 0
        || manifest.session_count as usize != manifest.sessions.len()
        || manifest.sessions.len() > max_sessions
    {
        return Err(TerminalError::Protocol(
            "invalid manager handover manifest".to_owned(),
        ));
    }
    let mut names = HashSet::with_capacity(manifest.sessions.len());
    for session in &manifest.sessions {
        let identity = session.vault_session.as_ref().ok_or_else(|| {
            TerminalError::Protocol("manager handover omitted vault identity".to_owned())
        })?;
        validate_session_name(&identity.name)?;
        if identity.generation == 0
            || session.columns < 2
            || session.rows < 2
            || session.pending_input.len() > pending_input_limits.frames
            || session
                .pending_input
                .iter()
                .try_fold(0_usize, |total, frame| total.checked_add(frame.len()))
                .is_none_or(|total| total > pending_input_limits.bytes)
            || !names.insert(identity.name.clone())
        {
            return Err(TerminalError::Protocol(
                "invalid manager handover session".to_owned(),
            ));
        }
    }
    Ok(())
}

fn manager_checksum(generation: u64, sessions: &[ManagerSessionState]) -> u64 {
    checksum(
        generation
            .to_be_bytes()
            .into_iter()
            .chain(sessions.iter().flat_map(Message::encode_to_vec)),
    )
}
