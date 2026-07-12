use std::collections::BTreeMap;

use pty_manager::protocol::ClientSummary;
use pty_manager::session_registry::SessionRegistry;

#[test]
fn ensure_running_creates_once_and_lists_supplied_clients() {
    let mut registry = SessionRegistry::new();

    assert!(registry
        .ensure_running("main", "/tmp/work", "/bin/zsh", 42)
        .expect("create"));
    assert!(!registry
        .ensure_running("main", "/tmp/other", "/bin/bash", 100)
        .expect("reuse"));

    let mut clients = BTreeMap::new();
    clients.insert(
        "main".to_owned(),
        vec![
            ClientSummary {
                id: 10,
                title: "left".to_owned(),
            },
            ClientSummary {
                id: 11,
                title: "right".to_owned(),
            },
        ],
    );

    let sessions = registry.list(&clients);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "main");
    assert_eq!(sessions[0].cwd, "/tmp/work");
    assert_eq!(sessions[0].shell, "/bin/zsh");
    assert_eq!(sessions[0].pid, 42);
    assert_eq!(sessions[0].clients.len(), 2);
    assert_eq!(sessions[0].clients[1].title, "right");
}

#[test]
fn exited_sessions_are_not_listed_and_can_be_recreated() {
    let mut registry = SessionRegistry::new();
    registry
        .ensure_running("main", "/tmp/work", "/bin/zsh", 42)
        .expect("create");

    registry.mark_exited("main").expect("exit");

    assert!(registry.list(&BTreeMap::new()).is_empty());
    assert!(registry
        .ensure_running("main", "/tmp/new", "/bin/sh", 100)
        .expect("recreate"));

    let sessions = registry.list(&BTreeMap::new());
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "main");
    assert_eq!(sessions[0].cwd, "/tmp/new");
    assert_eq!(sessions[0].shell, "/bin/sh");
    assert_eq!(sessions[0].pid, 100);
    assert!(sessions[0].clients.is_empty());
}

#[test]
fn remove_returns_record_and_drops_only_selected_session() {
    let mut registry = SessionRegistry::new();
    registry
        .ensure_running("main", "/tmp/main", "/bin/zsh", 42)
        .expect("main");
    registry
        .ensure_running("server", "/tmp/server", "/bin/zsh", 43)
        .expect("server");

    let removed = registry.remove("main").expect("remove");
    let sessions = registry.list(&BTreeMap::new());

    assert_eq!(removed.name, "main");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "server");
}
