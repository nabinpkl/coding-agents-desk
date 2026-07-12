use std::io::{self, Write};

use crossterm::{
    cursor, queue,
    style::{Attribute, Print, SetAttribute},
    terminal::{Clear, ClearType},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub columns: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterState {
    pub session_name: String,
    pub pid: u32,
    pub client_count: u32,
    pub shell: String,
    pub cwd: String,
}

pub fn child_pty_rows(size: TerminalSize) -> anyhow::Result<u16> {
    if size.rows < 2 {
        anyhow::bail!("footer mode requires a terminal at least 2 rows tall");
    }
    Ok(size.rows - 1)
}

pub fn footer_text(state: &FooterState, width: u16) -> String {
    let width = usize::from(width);
    if width == 0 {
        return String::new();
    }

    let text = format!(
        "[pty {}] pid={} clients={} {} {}    ^] detach",
        state.session_name, state.pid, state.client_count, state.shell, state.cwd
    );
    truncate_preserving_suffix(&text, width, "^] detach")
}

pub struct FooterRenderer {
    size: TerminalSize,
    active: bool,
}

impl FooterRenderer {
    pub fn new(size: TerminalSize) -> anyhow::Result<Self> {
        child_pty_rows(size)?;
        Ok(Self {
            size,
            active: false,
        })
    }

    pub fn size(&self) -> TerminalSize {
        self.size
    }

    pub fn child_rows(&self) -> u16 {
        self.size.rows - 1
    }

    pub fn activate(&mut self) -> anyhow::Result<()> {
        set_scroll_region(self.child_rows())?;
        self.active = true;
        Ok(())
    }

    pub fn resize(&mut self, size: TerminalSize) -> anyhow::Result<()> {
        child_pty_rows(size)?;
        self.size = size;
        if self.active {
            set_scroll_region(self.child_rows())?;
        }
        Ok(())
    }

    pub fn draw(&self, state: &FooterState) -> anyhow::Result<()> {
        let mut stdout = io::stdout().lock();
        let mut text = footer_text(state, self.size.columns);
        pad_to_width(&mut text, usize::from(self.size.columns));
        queue!(
            stdout,
            cursor::SavePosition,
            cursor::MoveTo(0, self.size.rows - 1),
            SetAttribute(Attribute::Reverse),
            Print(text),
            SetAttribute(Attribute::Reset),
            cursor::RestorePosition,
        )?;
        stdout.flush()?;
        Ok(())
    }

    pub fn restore(&mut self) -> anyhow::Result<()> {
        if !self.active {
            return Ok(());
        }
        self.active = false;
        let mut stdout = io::stdout().lock();
        write!(stdout, "\x1b[r")?;
        queue!(
            stdout,
            cursor::SavePosition,
            cursor::MoveTo(0, self.size.rows - 1),
            SetAttribute(Attribute::Reset),
            Clear(ClearType::CurrentLine),
            cursor::RestorePosition,
        )?;
        stdout.flush()?;
        Ok(())
    }
}

impl Drop for FooterRenderer {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn set_scroll_region(bottom_row: u16) -> anyhow::Result<()> {
    let mut stdout = io::stdout().lock();
    write!(stdout, "\x1b[1;{bottom_row}r")?;
    stdout.flush()?;
    Ok(())
}

fn truncate_preserving_suffix(text: &str, width: usize, suffix: &str) -> String {
    if text.len() <= width {
        return text.to_owned();
    }
    if width <= 3 {
        return text.chars().take(width).collect();
    }

    let suffix = format!(" {suffix}");
    if suffix.len() + 3 >= width {
        return text.chars().take(width).collect();
    }

    let prefix_width = width - suffix.len() - 3;
    let prefix: String = text.chars().take(prefix_width).collect();
    format!("{prefix}...{suffix}")
}

fn pad_to_width(text: &mut String, width: usize) {
    let len = text.len();
    if len < width {
        text.push_str(&" ".repeat(width - len));
    }
}
