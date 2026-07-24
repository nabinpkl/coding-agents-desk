use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::error::{Result, TerminalError};

pub fn publish(socket_path: &Path, digest: &str) -> Result<()> {
    validate_digest(digest)?;
    let destination = identity_path(socket_path);
    let temporary = destination.with_extension(format!("identity.{}", std::process::id()));
    let body = format!(
        "{{\"pid\":{},\"digest\":\"{}\"}}\n",
        std::process::id(),
        digest
    );
    fs::write(&temporary, body)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(temporary, destination)?;
    Ok(())
}

pub fn identity_path(socket_path: &Path) -> PathBuf {
    let file_name = socket_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pty-runtime.sock");
    socket_path.with_file_name(format!("{file_name}.identity"))
}

fn validate_digest(digest: &str) -> Result<()> {
    if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(TerminalError::Protocol(
            "PTY runtime digest must be 64 hexadecimal characters".to_owned(),
        ))
    }
}
