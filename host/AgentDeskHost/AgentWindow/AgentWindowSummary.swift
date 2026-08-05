import Foundation

/// One open Agents window, as a chooser needs to describe it.
///
/// Deliberately not the window itself: the top bar lists windows it does not own and must not be
/// able to reach into, and a value also survives the window closing between the list being built and
/// a row being clicked.
struct AgentWindowSummary: Equatable, Identifiable {
    let id: UUID
    /// The Desktop the window sits on, as an index into its display's Spaces. Zero-based, like the
    /// assignment it comes from.
    let desktopOrdinal: Int
    /// Its place in that Desktop's cascade, which is what distinguishes two windows on one Desktop.
    /// Zero-based, like the registry's own cascade bookkeeping.
    let cascadeOrdinal: Int

    /// Names the window by where it is rather than by what it contains. A panel's contents change as
    /// the user switches sessions, so a title taken from them would not still identify the same
    /// window a moment later; its Desktop and cascade position do.
    ///
    /// Both ordinals are counted from zero internally and shown from one, because Mission Control
    /// labels the first Desktop "Desktop 1" and a chooser that disagreed with it would be naming a
    /// different Desktop than the one the user is looking at.
    var title: String {
        "Agents \(cascadeOrdinal + 1) · Desktop \(desktopOrdinal + 1)"
    }
}
