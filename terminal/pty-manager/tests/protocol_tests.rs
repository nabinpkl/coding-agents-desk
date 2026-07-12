use pty_manager::protocol::{
    decode, encode, envelope, payload, validate_session_name, CreateOrAttach, Envelope, Payload,
    Resize, SubscribeSessions, PROTOCOL_VERSION,
};

#[test]
fn envelope_roundtrips_create_or_attach() {
    let original = envelope(
        7,
        "main",
        Payload::CreateOrAttach(CreateOrAttach {
            cwd: "/tmp/work".to_owned(),
            shell: "/bin/zsh".to_owned(),
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
