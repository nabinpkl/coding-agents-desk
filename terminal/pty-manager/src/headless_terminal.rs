use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor};

use crate::error::{Result, TerminalError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalDimensions {
    pub columns: usize,
    pub rows: usize,
}

impl Dimensions for TerminalDimensions {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct TerminalCheckpointData {
    pub revision: u64,
    pub columns: u32,
    pub rows: u32,
    pub ansi: Vec<u8>,
    pub history_truncated: bool,
}

#[derive(Clone, Default)]
struct HeadlessEventListener {
    pending: Arc<Mutex<Vec<Event>>>,
}

impl EventListener for HeadlessEventListener {
    fn send_event(&self, event: Event) {
        self.pending
            .lock()
            .expect("headless event lock poisoned")
            .push(event);
    }
}

pub struct HeadlessTerminal {
    term: Term<HeadlessEventListener>,
    parser: Processor,
    listener: HeadlessEventListener,
    dimensions: TerminalDimensions,
    revision: u64,
    checkpoint_bytes: usize,
    scrollback_lines: usize,
    history_truncated: bool,
    title: Option<String>,
}

impl HeadlessTerminal {
    pub fn new(columns: u16, rows: u16, scrollback_lines: usize, checkpoint_bytes: usize) -> Self {
        let dimensions = TerminalDimensions {
            columns: usize::from(columns),
            rows: usize::from(rows),
        };
        let listener = HeadlessEventListener::default();
        let config = Config {
            scrolling_history: scrollback_lines,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &dimensions, listener.clone()),
            parser: Processor::new(),
            listener,
            dimensions,
            revision: 1,
            checkpoint_bytes,
            scrollback_lines,
            history_truncated: false,
            title: None,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn dimensions(&self) -> TerminalDimensions {
        self.dimensions
    }

    pub fn apply_output(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| TerminalError::Protocol("terminal revision overflow".to_owned()))?;
        self.parser.advance(&mut self.term, bytes);
        if self.scrollback_lines > 0
            && self.term.replay_grids().primary.history_size() >= self.scrollback_lines
        {
            self.history_truncated = true;
        }
        self.revision = next_revision;
        Ok(self.drain_pty_responses())
    }

    pub fn resize(&mut self, columns: u16, rows: u16) -> Result<()> {
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| TerminalError::Protocol("terminal revision overflow".to_owned()))?;
        self.dimensions = TerminalDimensions {
            columns: usize::from(columns),
            rows: usize::from(rows),
        };
        self.term.resize(self.dimensions);
        self.revision = next_revision;
        Ok(())
    }

    pub fn checkpoint(&self) -> Result<TerminalCheckpointData> {
        let grids = self.term.replay_grids();
        let primary_visible_rows = encode_visible_rows(grids.primary);
        let alternate_rows = encode_visible_rows(grids.alternate);

        let mut prefix = b"\x1bc\x1b[?25l".to_vec();
        let primary_cursor = &grids.primary.cursor;
        let primary_saved = &grids.primary.saved_cursor;
        let mut suffix = b"\x1b[2J\x1b[H".to_vec();

        append_visible_rows(&primary_visible_rows, &mut suffix);
        restore_saved_cursor(primary_saved, &mut suffix);
        restore_active_cursor(primary_cursor, &mut suffix);

        suffix.extend_from_slice(b"\x1b[?1049h\x1b[2J\x1b[H");
        append_visible_rows(&alternate_rows, &mut suffix);
        let alternate_cursor = &grids.alternate.cursor;
        restore_saved_cursor(&grids.alternate.saved_cursor, &mut suffix);
        restore_active_cursor(alternate_cursor, &mut suffix);
        if !grids.alternate_active {
            suffix.extend_from_slice(b"\x1b[?1049l");
            restore_active_cursor(primary_cursor, &mut suffix);
        }
        append_tab_stops(grids.tab_stops, &mut suffix);
        append_scroll_region(&grids.scroll_region, &mut suffix);
        append_modes(*self.term.mode(), &mut suffix);
        append_cursor_style(
            self.term.cursor_style().shape,
            self.term.cursor_style().blinking,
            &mut suffix,
        );
        if let Some(title) = &self.title {
            suffix.extend_from_slice(b"\x1b]2;");
            suffix.extend_from_slice(title.as_bytes());
            suffix.extend_from_slice(b"\x1b\\");
        }
        let active_cursor = if grids.alternate_active {
            alternate_cursor
        } else {
            primary_cursor
        };
        restore_active_cursor(active_cursor, &mut suffix);

        let mandatory_bytes = prefix.len() + suffix.len();
        if mandatory_bytes > self.checkpoint_bytes {
            return Err(TerminalError::Protocol("checkpoint-too-large".to_owned()));
        }

        drop(primary_visible_rows);
        drop(alternate_rows);
        let history_budget = self.checkpoint_bytes - mandatory_bytes;
        let (history_rows, checkpoint_trimmed) =
            encode_bounded_history(grids.primary, history_budget);
        let history_truncated = self.history_truncated || checkpoint_trimmed;
        for row in history_rows {
            append_row(row, &mut prefix);
        }
        prefix.extend_from_slice(&suffix);

        Ok(TerminalCheckpointData {
            revision: self.revision,
            columns: self.dimensions.columns as u32,
            rows: self.dimensions.rows as u32,
            ansi: prefix,
            history_truncated,
        })
    }

    fn drain_pty_responses(&mut self) -> Vec<Vec<u8>> {
        let events = std::mem::take(
            &mut *self
                .listener
                .pending
                .lock()
                .expect("headless event lock poisoned"),
        );
        let window_size = WindowSize {
            num_lines: self.dimensions.rows as u16,
            num_cols: self.dimensions.columns as u16,
            cell_width: 0,
            cell_height: 0,
        };
        let mut responses = Vec::new();
        for event in events {
            match event {
                Event::PtyWrite(text) => responses.push(text.into_bytes()),
                Event::TextAreaSizeRequest(formatter) => {
                    responses.push(formatter(window_size).into_bytes())
                }
                Event::Title(title) => self.title = bounded_title(title),
                Event::ResetTitle => self.title = None,
                _ => {}
            }
        }
        responses
    }
}

#[derive(Debug)]
struct EncodedRow {
    bytes: Vec<u8>,
    wrapped: bool,
}

impl EncodedRow {
    fn encoded_len(&self) -> usize {
        self.bytes.len() + if self.wrapped { 0 } else { 2 }
    }
}

fn encode_bounded_history(grid: &Grid<Cell>, byte_budget: usize) -> (VecDeque<EncodedRow>, bool) {
    let mut rows: VecDeque<EncodedRow> = VecDeque::new();
    let mut encoded_bytes = 0usize;
    let mut truncated = false;
    for line in grid.topmost_line().0..0 {
        let row = encode_row(grid, Line(line));
        let row_bytes = row.encoded_len();
        if row_bytes > byte_budget {
            rows.clear();
            encoded_bytes = 0;
            truncated = true;
            continue;
        }
        while encoded_bytes + row_bytes > byte_budget {
            let Some(removed) = rows.pop_front() else {
                break;
            };
            encoded_bytes = encoded_bytes.saturating_sub(removed.encoded_len());
            truncated = true;
        }
        encoded_bytes += row_bytes;
        rows.push_back(row);
    }
    (rows, truncated)
}

fn encode_visible_rows(grid: &Grid<Cell>) -> Vec<EncodedRow> {
    (0..grid.screen_lines())
        .map(|line| encode_row(grid, Line(line as i32)))
        .collect()
}

fn encode_row(grid: &Grid<Cell>, line: Line) -> EncodedRow {
    let row = &grid[line];
    let last = (0..grid.columns()).rfind(|column| is_meaningful(&row[Column(*column)]));
    let wrapped = row[Column(grid.columns() - 1)]
        .flags
        .contains(Flags::WRAPLINE);
    let Some(last) = last else {
        return EncodedRow {
            bytes: Vec::new(),
            wrapped,
        };
    };

    let mut output = Vec::new();
    let mut previous: Option<CellStyle> = None;
    for column in 0..=last {
        let cell = &row[Column(column)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let style = CellStyle::from(cell);
        if previous.as_ref() != Some(&style) {
            emit_style(&style, &mut output);
            previous = Some(style);
        }
        let mut buffer = [0; 4];
        output.extend_from_slice(cell.c.encode_utf8(&mut buffer).as_bytes());
        if let Some(zerowidth) = cell.zerowidth() {
            for character in zerowidth {
                output.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    output.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\");
    EncodedRow {
        bytes: output,
        wrapped,
    }
}

fn append_row(row: EncodedRow, output: &mut Vec<u8>) {
    output.extend_from_slice(&row.bytes);
    if !row.wrapped {
        output.extend_from_slice(b"\r\n");
    }
}

fn append_visible_rows(rows: &[EncodedRow], output: &mut Vec<u8>) {
    let mut previous_wrapped = false;
    for (line, row) in rows.iter().enumerate() {
        if !previous_wrapped {
            output.extend_from_slice(format!("\x1b[{};1H", line + 1).as_bytes());
        } else if row.bytes.is_empty() {
            // Trigger the pending autowrap so the preceding row retains its
            // WRAPLINE state, then erase the placeholder cell.
            output.extend_from_slice(b" \x1b[2K");
        }
        output.extend_from_slice(&row.bytes);
        previous_wrapped = row.wrapped;
    }
}

fn append_tab_stops(tab_stops: &[bool], output: &mut Vec<u8>) {
    output.extend_from_slice(b"\x1b[3g");
    for (column, is_stop) in tab_stops.iter().copied().enumerate() {
        if is_stop {
            output.extend_from_slice(format!("\x1b[{}G\x1bH", column + 1).as_bytes());
        }
    }
}

fn append_scroll_region(region: &std::ops::Range<Line>, output: &mut Vec<u8>) {
    output.extend_from_slice(
        format!("\x1b[{};{}r", region.start.0 + 1, region.end.0.max(1)).as_bytes(),
    );
}

fn is_meaningful(cell: &Cell) -> bool {
    cell.c != ' '
        || cell.fg != Color::Named(NamedColor::Foreground)
        || cell.bg != Color::Named(NamedColor::Background)
        || !cell.flags.is_empty()
        || cell.extra.is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CellStyle {
    foreground: Color,
    background: Color,
    underline: Option<Color>,
    flags: Flags,
    hyperlink: Option<(String, String)>,
}

impl From<&Cell> for CellStyle {
    fn from(cell: &Cell) -> Self {
        let hyperlink = cell
            .hyperlink()
            .map(|link| (link.id().to_owned(), link.uri().to_owned()));
        Self {
            foreground: cell.fg,
            background: cell.bg,
            underline: cell.underline_color(),
            flags: cell.flags,
            hyperlink,
        }
    }
}

fn emit_style(style: &CellStyle, output: &mut Vec<u8>) {
    output.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\");
    if let Some((id, uri)) = &style.hyperlink {
        output.extend_from_slice(format!("\x1b]8;id={id};{uri}\x1b\\").as_bytes());
    }
    let flags = style.flags;
    if flags.contains(Flags::BOLD) {
        output.extend_from_slice(b"\x1b[1m");
    }
    if flags.contains(Flags::DIM) {
        output.extend_from_slice(b"\x1b[2m");
    }
    if flags.contains(Flags::ITALIC) {
        output.extend_from_slice(b"\x1b[3m");
    }
    let underline = if flags.contains(Flags::DOUBLE_UNDERLINE) {
        Some(2)
    } else if flags.contains(Flags::UNDERCURL) {
        Some(3)
    } else if flags.contains(Flags::DOTTED_UNDERLINE) {
        Some(4)
    } else if flags.contains(Flags::DASHED_UNDERLINE) {
        Some(5)
    } else if flags.contains(Flags::UNDERLINE) {
        Some(1)
    } else {
        None
    };
    if let Some(value) = underline {
        output.extend_from_slice(format!("\x1b[4:{value}m").as_bytes());
    }
    if flags.contains(Flags::INVERSE) {
        output.extend_from_slice(b"\x1b[7m");
    }
    if flags.contains(Flags::HIDDEN) {
        output.extend_from_slice(b"\x1b[8m");
    }
    if flags.contains(Flags::STRIKEOUT) {
        output.extend_from_slice(b"\x1b[9m");
    }
    emit_color(style.foreground, 38, 39, output);
    emit_color(style.background, 48, 49, output);
    if let Some(color) = style.underline {
        emit_color(color, 58, 59, output);
    }
}

fn emit_color(color: Color, extended: u8, default: u8, output: &mut Vec<u8>) {
    match color {
        Color::Spec(rgb) => output.extend_from_slice(
            format!("\x1b[{extended};2;{};{};{}m", rgb.r, rgb.g, rgb.b).as_bytes(),
        ),
        Color::Indexed(index) => {
            output.extend_from_slice(format!("\x1b[{extended};5;{index}m").as_bytes())
        }
        Color::Named(named) => {
            let code = named_color_code(named, extended == 38, default);
            output.extend_from_slice(format!("\x1b[{code}m").as_bytes());
        }
    }
}

fn named_color_code(color: NamedColor, foreground: bool, default: u8) -> u8 {
    match (foreground, color) {
        (true, NamedColor::Black) => 30,
        (true, NamedColor::Red) => 31,
        (true, NamedColor::Green) => 32,
        (true, NamedColor::Yellow) => 33,
        (true, NamedColor::Blue) => 34,
        (true, NamedColor::Magenta) => 35,
        (true, NamedColor::Cyan) => 36,
        (true, NamedColor::White) => 37,
        (true, NamedColor::BrightBlack) => 90,
        (true, NamedColor::BrightRed) => 91,
        (true, NamedColor::BrightGreen) => 92,
        (true, NamedColor::BrightYellow) => 93,
        (true, NamedColor::BrightBlue) => 94,
        (true, NamedColor::BrightMagenta) => 95,
        (true, NamedColor::BrightCyan) => 96,
        (true, NamedColor::BrightWhite) => 97,
        (false, NamedColor::Black) => 40,
        (false, NamedColor::Red) => 41,
        (false, NamedColor::Green) => 42,
        (false, NamedColor::Yellow) => 43,
        (false, NamedColor::Blue) => 44,
        (false, NamedColor::Magenta) => 45,
        (false, NamedColor::Cyan) => 46,
        (false, NamedColor::White) => 47,
        (false, NamedColor::BrightBlack) => 100,
        (false, NamedColor::BrightRed) => 101,
        (false, NamedColor::BrightGreen) => 102,
        (false, NamedColor::BrightYellow) => 103,
        (false, NamedColor::BrightBlue) => 104,
        (false, NamedColor::BrightMagenta) => 105,
        (false, NamedColor::BrightCyan) => 106,
        (false, NamedColor::BrightWhite) => 107,
        _ => default,
    }
}

fn restore_saved_cursor(cursor: &alacritty_terminal::grid::Cursor<Cell>, output: &mut Vec<u8>) {
    emit_style(&CellStyle::from(&cursor.template), output);
    restore_cursor(cursor.point.line, cursor.point.column, output);
    output.extend_from_slice(b"\x1b7");
}

fn restore_active_cursor(cursor: &alacritty_terminal::grid::Cursor<Cell>, output: &mut Vec<u8>) {
    emit_style(&CellStyle::from(&cursor.template), output);
    restore_cursor(cursor.point.line, cursor.point.column, output);
}

fn restore_cursor(line: Line, column: Column, output: &mut Vec<u8>) {
    output.extend_from_slice(format!("\x1b[{};{}H", line.0.max(0) + 1, column.0 + 1).as_bytes());
}

fn append_modes(mode: TermMode, output: &mut Vec<u8>) {
    for (flag, code) in [
        (TermMode::APP_CURSOR, 1),
        (TermMode::ORIGIN, 6),
        (TermMode::LINE_WRAP, 7),
        (TermMode::MOUSE_REPORT_CLICK, 1000),
        (TermMode::MOUSE_DRAG, 1002),
        (TermMode::MOUSE_MOTION, 1003),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::SGR_MOUSE, 1006),
        (TermMode::ALTERNATE_SCROLL, 1007),
        (TermMode::BRACKETED_PASTE, 2004),
    ] {
        let suffix = if mode.contains(flag) { 'h' } else { 'l' };
        output.extend_from_slice(format!("\x1b[?{code}{suffix}").as_bytes());
    }
    for (flag, code) in [(TermMode::INSERT, 4), (TermMode::LINE_FEED_NEW_LINE, 20)] {
        let suffix = if mode.contains(flag) { 'h' } else { 'l' };
        output.extend_from_slice(format!("\x1b[{code}{suffix}").as_bytes());
    }
    output.extend_from_slice(if mode.contains(TermMode::APP_KEYPAD) {
        b"\x1b="
    } else {
        b"\x1b>"
    });
    if mode.contains(TermMode::SHOW_CURSOR) {
        output.extend_from_slice(b"\x1b[?25h");
    }
}

fn append_cursor_style(shape: CursorShape, blinking: bool, output: &mut Vec<u8>) {
    let code = match (shape, blinking) {
        (CursorShape::Block | CursorShape::HollowBlock, true) => 1,
        (CursorShape::Block | CursorShape::HollowBlock, false) => 2,
        (CursorShape::Underline, true) => 3,
        (CursorShape::Underline, false) => 4,
        (CursorShape::Beam, true) => 5,
        (CursorShape::Beam, false) => 6,
        (CursorShape::Hidden, _) => return,
    };
    output.extend_from_slice(format!("\x1b[{code} q").as_bytes());
}

fn bounded_title(title: String) -> Option<String> {
    let mut bounded = String::new();
    for character in title.chars().filter(|character| !character.is_control()) {
        if bounded.len() + character.len_utf8() > 1_024 {
            break;
        }
        bounded.push(character);
    }
    (!bounded.is_empty()).then_some(bounded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_contains_primary_and_active_alternate_state() {
        let mut terminal = HeadlessTerminal::new(18, 5, 6, 1024 * 1024);
        terminal.apply_output(b"primary\r\n").unwrap();
        terminal
            .apply_output(b"\x1b[?1049h\x1b[2J\x1b[HALTERNATE")
            .unwrap();

        let checkpoint = terminal.checkpoint().unwrap();
        assert!(checkpoint
            .ansi
            .windows(b"primary".len())
            .any(|bytes| bytes == b"primary"));
        assert!(checkpoint
            .ansi
            .windows(b"ALTERNATE".len())
            .any(|bytes| bytes == b"ALTERNATE"));
        assert_eq!(checkpoint.revision, 3);
    }

    #[test]
    fn terminal_query_is_returned_once_by_headless_owner() {
        let mut terminal = HeadlessTerminal::new(80, 24, 10, 1024 * 1024);
        let responses = terminal.apply_output(b"\x1b[6n").unwrap();
        assert_eq!(responses.len(), 1);
        assert!(responses[0].starts_with(b"\x1b["));
    }

    #[test]
    fn checkpoint_trims_oldest_history_to_byte_budget() {
        let mut terminal = HeadlessTerminal::new(20, 3, 100, 700);
        for index in 0..40 {
            terminal
                .apply_output(format!("line-{index:02}\r\n").as_bytes())
                .unwrap();
        }
        let checkpoint = terminal.checkpoint().unwrap();
        assert!(checkpoint.history_truncated);
        assert!(checkpoint.ansi.len() <= 700);
    }

    #[test]
    fn checkpoint_reports_when_bounded_headless_scrollback_was_exhausted() {
        let mut terminal = HeadlessTerminal::new(20, 3, 2, 1024 * 1024);
        for index in 0..20 {
            terminal
                .apply_output(format!("line-{index:02}\r\n").as_bytes())
                .unwrap();
        }

        let checkpoint = terminal.checkpoint().unwrap();

        assert!(checkpoint.history_truncated);
    }

    #[test]
    fn revision_overflow_fails_before_applying_more_output() {
        let mut terminal = HeadlessTerminal::new(20, 3, 2, 1024 * 1024);
        terminal.revision = u64::MAX;

        let error = terminal.apply_output(b"must-not-appear").unwrap_err();

        assert!(error.to_string().contains("terminal revision overflow"));
        assert!(!terminal
            .checkpoint()
            .unwrap()
            .ansi
            .windows(b"must-not-appear".len())
            .any(|bytes| bytes == b"must-not-appear"));
    }

    #[test]
    fn checkpoint_replays_wrap_tabs_margins_title_and_modes() {
        let mut source = HeadlessTerminal::new(5, 4, 10, 1024 * 1024);
        source
            .apply_output(
                b"\x1b]2;fixture-title\x1b\\\x1b[3g\x1b[3G\x1bH\x1b[2;4r\x1b[?2004habcdef",
            )
            .unwrap();

        let checkpoint = source.checkpoint().unwrap();
        let mut receiver = HeadlessTerminal::new(5, 4, 10, 1024 * 1024);
        receiver.apply_output(&checkpoint.ansi).unwrap();
        let replayed = receiver.term.replay_grids();

        assert!(
            replayed.primary[Line(0)][Column(4)]
                .flags
                .contains(Flags::WRAPLINE),
            "checkpoint={:?}; rows={:?}",
            String::from_utf8_lossy(&checkpoint.ansi),
            (0..4)
                .map(|line| {
                    let row = &replayed.primary[Line(line)];
                    (0..5)
                        .map(|column| row[Column(column)].c)
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(replayed.scroll_region, Line(1)..Line(4));
        assert_eq!(replayed.tab_stops, &[false, false, true, false, false]);
        assert!(receiver.term.mode().contains(TermMode::BRACKETED_PASTE));
        assert_eq!(receiver.title.as_deref(), Some("fixture-title"));
    }
}
