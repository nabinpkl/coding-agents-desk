use pty_manager::protocol::{
    create_or_attach, decode, encode, envelope, payload, validate_session_name, CommandLaunch,
    CreateOrAttach, Envelope, Output, Payload, RequestTerminalCheckpoint,
    SessionState, SessionSummary, ShellLaunch, SubscribeSessions, TerminalCheckpointBegin,
    TerminalCheckpointChunk, TerminalCheckpointEnd, TerminalViewerState, TerminalViewportStatus,
    PROTOCOL_VERSION,
};

#[test]
fn protocol_version_is_seven() {
    assert_eq!(PROTOCOL_VERSION, 7);
}

#[test]
fn chunked_checkpoint_and_revisioned_output_roundtrip() {
    let begin = envelope(
        7,
        "main",
        Payload::TerminalCheckpointBegin(TerminalCheckpointBegin {
            checkpoint_id: 9,
            revision: 41,
            columns: 100,
            rows: 30,
            total_bytes: 10,
            chunk_count: 1,
            history_truncated: true,
        }),
    );
    let chunk = envelope(
        0,
        "main",
        Payload::TerminalCheckpointChunk(TerminalCheckpointChunk {
            checkpoint_id: 9,
            index: 0,
            data: b"checkpoint".to_vec(),
        }),
    );
    let end = envelope(
        0,
        "main",
        Payload::TerminalCheckpointEnd(TerminalCheckpointEnd {
            checkpoint_id: 9,
            revision: 41,
        }),
    );
    let output = envelope(
        0,
        "main",
        Payload::Output(Output {
            data: b" next".to_vec(),
            revision: 42,
        }),
    );

    assert_eq!(
        decode(&encode(&begin).expect("encode")).expect("decode"),
        begin
    );
    assert_eq!(
        decode(&encode(&chunk).expect("encode")).expect("decode"),
        chunk
    );
    assert_eq!(decode(&encode(&end).expect("encode")).expect("decode"), end);
    assert_eq!(
        decode(&encode(&output).expect("encode")).expect("decode"),
        output
    );
}

#[test]
fn checkpoint_request_roundtrips() {
    let request = envelope(
        12,
        "main",
        Payload::RequestTerminalCheckpoint(RequestTerminalCheckpoint {
            last_applied_revision: 41,
        }),
    );
    assert_eq!(
        decode(&encode(&request).expect("encode")).expect("decode"),
        request
    );
}

#[test]
fn envelope_roundtrips_shell_launch_and_persistent_lifetime() {
    let original = envelope(
        7,
        "main",
        Payload::CreateOrAttach(CreateOrAttach {
            launch: Some(create_or_attach::Launch::ShellLaunch(ShellLaunch {
                cwd: "/tmp/work".to_owned(),
                shell: "/bin/zsh".to_owned(),
            })),
            columns: 120,
            rows: 40,
            create_if_missing: true,
            client_title: "test".to_owned(),
        }),
    );

    let encoded = encode(&original).expect("encode");
    let decoded = decode(&encoded).expect("decode");

    assert_eq!(decoded, original);
    assert!(matches!(
        payload(decoded).expect("payload"),
        Payload::CreateOrAttach(_)
    ));
}

#[test]
fn envelope_roundtrips_command_launch_argument_boundaries() {
    let arguments = vec![
        "resume".to_owned(),
        "id with spaces".to_owned(),
        "$(not-expanded)".to_owned(),
        "semi;colon".to_owned(),
    ];
    let original = envelope(
        8,
        "agent-resume-codex-session",
        Payload::CreateOrAttach(CreateOrAttach {
            launch: Some(create_or_attach::Launch::CommandLaunch(CommandLaunch {
                cwd: "/tmp/project with spaces".to_owned(),
                executable: "/usr/local/bin/codex".to_owned(),
                arguments: arguments.clone(),
            })),
            columns: 100,
            rows: 30,
            create_if_missing: true,
            client_title: "Agent Panel".to_owned(),
        }),
    );

    let decoded = decode(&encode(&original).expect("encode")).expect("decode");
    let Payload::CreateOrAttach(request) = payload(decoded).expect("payload") else {
        panic!("expected create or attach");
    };
    let Some(create_or_attach::Launch::CommandLaunch(command)) = request.launch else {
        panic!("expected command launch");
    };
    assert_eq!(command.cwd, "/tmp/project with spaces");
    assert_eq!(command.executable, "/usr/local/bin/codex");
    assert_eq!(command.arguments, arguments);
}

#[test]
fn session_summary_roundtrips_lifetime_and_creation_time() {
    let original = envelope(
        9,
        "",
        Payload::SessionList(pty_manager::protocol::SessionList {
            sessions: vec![SessionSummary {
                name: "main".to_owned(),
                cwd: "/tmp/work".to_owned(),
                shell: "/bin/zsh".to_owned(),
                pid: 42,
                state: SessionState::Running as i32,
                clients: Vec::new(),
                started_at_unix_milliseconds: 1_721_344_000_123,
                columns: 80,
                rows: 24,
                revision: 9,
                owner_client_id: 7,
                ownership_epoch: 3,
            }],
        }),
    );

    let decoded = decode(&encode(&original).expect("encode")).expect("decode");
    let Payload::SessionList(list) = payload(decoded).expect("payload") else {
        panic!("expected session list");
    };
    assert_eq!(
        list.sessions[0].started_at_unix_milliseconds,
        1_721_344_000_123
    );
}

#[test]
fn rejects_protocol_version_six() {
    let original = Envelope {
        protocol_version: 6,
        request_id: 1,
        session_name: "main".to_owned(),
        payload: None,
    };

    let encoded = encode(&original).expect("encode");

    assert!(decode(&encoded).is_err());
}

#[test]
fn envelope_roundtrips_subscribe_sessions() {
    let original = envelope(11, "", Payload::SubscribeSessions(SubscribeSessions {}));

    let encoded = encode(&original).expect("encode");
    let decoded = decode(&encoded).expect("decode");

    assert_eq!(decoded, original);
    assert!(matches!(
        payload(decoded).expect("payload"),
        Payload::SubscribeSessions(_)
    ));
}

#[test]
fn envelope_roundtrips_viewer_state_and_targeted_status() {
    let state = envelope(
        12,
        "main",
        Payload::TerminalViewerState(TerminalViewerState {
            sequence: 4,
            active: true,
            claim: true,
            columns: 100,
            rows: 29,
        }),
    );
    let status = envelope(
        0,
        "main",
        Payload::TerminalViewportStatus(TerminalViewportStatus {
            ownership_epoch: 3,
            owner_client_id: 7,
            owner_title: "Mac Terminal".to_owned(),
            is_owner: true,
            source_columns: 100,
            source_rows: 29,
            source_revision: 12,
            view_columns: 100,
            view_rows: 29,
        }),
    );

    assert_eq!(
        decode(&encode(&state).expect("encode")).expect("decode"),
        state
    );
    assert_eq!(
        decode(&encode(&status).expect("encode")).expect("decode"),
        status
    );
}

#[test]
fn validates_session_names() {
    validate_session_name("main").expect("valid");
    validate_session_name("0").expect("valid");
    validate_session_name("work.tree-1").expect("valid");

    assert!(validate_session_name("").is_err());
    assert!(validate_session_name("bad name").is_err());
    assert!(validate_session_name("../bad").is_err());
}
