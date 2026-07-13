use pty_manager::protocol::{
    create_or_attach, decode, encode, envelope, payload, validate_session_name, CommandLaunch,
    CreateOrAttach, Envelope, Payload, Resize, SessionLifetime, SessionState, SessionSummary,
    ShellLaunch, SubscribeSessions, PROTOCOL_VERSION,
};

#[test]
fn protocol_version_is_four() {
    assert_eq!(PROTOCOL_VERSION, 4);
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
            lifetime: SessionLifetime::Persistent as i32,
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
fn envelope_roundtrips_command_launch_argument_boundaries_and_leased_lifetime() {
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
            lifetime: SessionLifetime::Leased as i32,
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
    assert_eq!(request.lifetime(), SessionLifetime::Leased);
    let Some(create_or_attach::Launch::CommandLaunch(command)) = request.launch else {
        panic!("expected command launch");
    };
    assert_eq!(command.cwd, "/tmp/project with spaces");
    assert_eq!(command.executable, "/usr/local/bin/codex");
    assert_eq!(command.arguments, arguments);
}

#[test]
fn session_summary_roundtrips_lifetime() {
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
                lifetime: SessionLifetime::Persistent as i32,
            }],
        }),
    );

    let decoded = decode(&encode(&original).expect("encode")).expect("decode");
    let Payload::SessionList(list) = payload(decoded).expect("payload") else {
        panic!("expected session list");
    };
    assert_eq!(list.sessions[0].lifetime(), SessionLifetime::Persistent);
}

#[test]
fn rejects_unsupported_protocol_version() {
    let original = Envelope {
        protocol_version: PROTOCOL_VERSION + 1,
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
fn envelope_roundtrips_resize() {
    let original = envelope(
        12,
        "main",
        Payload::Resize(Resize {
            columns: 100,
            rows: 29,
        }),
    );

    let encoded = encode(&original).expect("encode");
    let decoded = decode(&encoded).expect("decode");

    assert_eq!(decoded, original);
    assert!(matches!(
        payload(decoded).expect("payload"),
        Payload::Resize(_)
    ));
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
