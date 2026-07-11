import Foundation

/// A workspace's open files as an ordered tab strip plus which tab is active. Pure value type,
/// no I/O — the authoritative tab state the in-shell viewer mirrors. URLs are standardized on
/// the way in so the same file via different path spellings is one tab.
///
/// Active-tab choice on close follows the editor convention: closing the active tab activates
/// the tab that slides into its place (its former right neighbor), or the new last tab when the
/// active one was rightmost.
public struct OpenTabs: Equatable {
    public private(set) var identities: [FileTabIdentity]
    public private(set) var activeIndex: Int?

    public init() {
        identities = []
        activeIndex = nil
    }

    public var urls: [URL] {
        Array(Set(identities.map(\.url))).sorted { $0.path < $1.path }
    }

    public var orderedURLs: [URL] {
        identities.map(\.url)
    }

    /// The active file, or nil when there are no tabs.
    public var active: FileTabIdentity? {
        guard let activeIndex, identities.indices.contains(activeIndex) else { return nil }
        return identities[activeIndex]
    }

    public var isEmpty: Bool { identities.isEmpty }

    /// Open `url`, making it active. Re-activates the existing tab if already open; otherwise
    /// appends a new tab at the end.
    public mutating func open(_ url: URL) {
        open(FileTabIdentity.opening(url))
    }

    public mutating func open(_ identity: FileTabIdentity) {
        if let index = identities.firstIndex(of: identity) {
            activeIndex = index
        } else {
            identities.append(identity)
            activeIndex = identities.count - 1
        }
    }

    /// Activate an already-open tab. No-op if `url` isn't open.
    public mutating func activate(_ identity: FileTabIdentity) {
        if let index = identities.firstIndex(of: identity) {
            activeIndex = index
        }
    }

    /// Close `url`'s tab. Recomputes the active tab: if the closed tab was active, the slot's
    /// new occupant (former right neighbor, or new last) becomes active; otherwise the
    /// previously-active file stays active at its shifted index. No-op if `url` isn't open.
    public mutating func close(_ identity: FileTabIdentity) {
        guard let removeIndex = identities.firstIndex(of: identity) else { return }
        let wasActive = activeIndex == removeIndex
        let previouslyActive = active
        identities.remove(at: removeIndex)
        if identities.isEmpty {
            activeIndex = nil
        } else if wasActive {
            activeIndex = min(removeIndex, identities.count - 1)
        } else {
            activeIndex = previouslyActive.flatMap { identities.firstIndex(of: $0) }
        }
    }
}
