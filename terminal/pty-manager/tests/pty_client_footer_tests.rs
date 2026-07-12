use pty_manager::pty_client_footer::{child_pty_rows, footer_text, FooterState, TerminalSize};

#[test]
fn footer_text_fits_terminal_width() {
    let text = footer_text(
        &FooterState {
            session_name: "main".to_owned(),
            pid: 12345,
            client_count: 2,
            shell: "/bin/zsh".to_owned(),
            cwd: "/Users/dev/projects/agent-workspace-ide".to_owned(),
        },
        40,
    );

    assert!(text.len() <= 40);
    assert!(text.starts_with("[pty main]"));
    assert!(text.contains("^] detach"));
}

#[test]
fn child_pty_rows_reserves_footer_row() {
    assert_eq!(
        child_pty_rows(TerminalSize {
            columns: 120,
            rows: 40
        })
        .expect("child rows"),
        39
    );
}

#[test]
fn child_pty_rows_rejects_one_row_terminal() {
    assert!(child_pty_rows(TerminalSize {
        columns: 120,
        rows: 1
    })
    .is_err());
}
