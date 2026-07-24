use std::time::Duration;

use crate::error::{Result, TerminalError};

const DEFAULT_HANDOVER_TIMEOUT_MILLISECONDS: usize = 5_000;
const DEFAULT_MAX_PENDING_INPUT_FRAMES: usize = 16;
const DEFAULT_MAX_PENDING_INPUT_BYTES: usize = 1024 * 1024;

pub(crate) struct PendingInputLimits {
    pub(crate) frames: usize,
    pub(crate) bytes: usize,
}

pub(crate) fn handover_timeout() -> Result<Duration> {
    let milliseconds = positive_usize(
        "AGENTDESK_PTY_HANDOVER_TIMEOUT_MILLISECONDS",
        DEFAULT_HANDOVER_TIMEOUT_MILLISECONDS,
    )?;
    Ok(Duration::from_millis(milliseconds as u64))
}

pub(crate) fn pending_input_limits() -> Result<PendingInputLimits> {
    Ok(PendingInputLimits {
        frames: usize_at_least(
            "AGENTDESK_PTY_HANDOVER_MAX_PENDING_INPUT_FRAMES",
            DEFAULT_MAX_PENDING_INPUT_FRAMES,
            2,
        )?,
        bytes: positive_usize(
            "AGENTDESK_PTY_HANDOVER_MAX_PENDING_INPUT_BYTES",
            DEFAULT_MAX_PENDING_INPUT_BYTES,
        )?,
    })
}

fn positive_usize(key: &str, default_value: usize) -> Result<usize> {
    usize_at_least(key, default_value, 1)
}

fn usize_at_least(key: &str, default_value: usize, minimum: usize) -> Result<usize> {
    let Some(value) = std::env::var_os(key) else {
        return Ok(default_value);
    };
    let value = value
        .to_str()
        .ok_or_else(|| TerminalError::Protocol(format!("{key} must be valid UTF-8")))?
        .parse::<usize>()
        .map_err(|_| TerminalError::Protocol(format!("{key} must be a positive integer")))?;
    if value < minimum {
        return Err(TerminalError::Protocol(format!(
            "{key} must be an integer of at least {minimum}"
        )));
    }
    Ok(value)
}
