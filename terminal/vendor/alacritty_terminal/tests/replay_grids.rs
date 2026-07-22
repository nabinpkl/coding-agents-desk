use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;

#[derive(Clone, Copy)]
struct Size;

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        3
    }
    fn screen_lines(&self) -> usize {
        3
    }
    fn columns(&self) -> usize {
        12
    }
}

#[test]
fn replay_grids_keep_primary_visible_while_alternate_is_active() {
    let mut term = Term::new(Config::default(), &Size, VoidListener);
    let mut parser = Processor::new();
    parser.advance(&mut term, b"primary");
    parser.advance(&mut term, b"\x1b[?1049halternate");

    let grids = term.replay_grids();
    assert!(grids.alternate_active);
    assert_eq!(grids.primary[Line(0)][Column(0)].c, 'p');
    assert_eq!(grids.alternate[Line(0)][Column(0)].c, 'a');
    assert_eq!(grids.scroll_region, Line(0)..Line(3));
    assert!(grids.tab_stops[0]);
    assert!(grids.tab_stops[8]);
    assert!(!grids.tab_stops[1]);
}
