import Foundation

/// Tracks, per open file, the on-disk `FileRevision` the viewer is currently in sync with, and
/// decides — on each `FolderWatch` fire — which open tabs changed underneath us. This is the
/// optimistic-concurrency seam that lets the viewer live-reload a clean tab when something else
/// (an agent in the terminal, a `git checkout`, a formatter) rewrites the file, while **not**
/// reacting to our own autosave: after a write we re-`seed` the baseline to the file we just
/// wrote, so that revision compares equal and is skipped.
///
/// It owns only the revision bookkeeping + the change decision; reading the file's bytes and
/// pushing them to the web stays in `FileViewer` (the one place that reads + classifies + renders
/// a file). Pure decision: the revision lookup is injected, so the unit tests need no real disk.
/// Main-thread only (driven from the `FolderWatch` callback, which already hops to main).
public final class OpenFileSync {
    /// What a reconcile pass found for one open tab.
    public enum FileChange: Equatable {
        case modified(URL)
        case deleted(URL)
    }

    /// The revision each tracked file was last seen in sync with. Keyed by `standardizedFileURL`
    /// to match `OpenTabs`. A `nil` *value* records a file known to be absent (deleted while
    /// open), so it isn't re-reported as deleted every pass.
    private var synced: [URL: FileRevision?] = [:]
    private let revisionOf: (URL) -> FileRevision?

    public init(revisionOf: @escaping (URL) -> FileRevision? = FileRevision.of) {
        self.revisionOf = revisionOf
    }

    /// Record `url`'s current on-disk revision as the in-sync baseline. Called when the viewer
    /// reads a file for render and after each successful save — both mean "the web now matches
    /// disk". This is also the echo-suppression hook: re-seeding to what we just wrote makes the
    /// following `FolderWatch` event (our own write) compare equal and be skipped.
    public func seed(_ url: URL) {
        synced[url.standardizedFileURL] = .some(revisionOf(url.standardizedFileURL))
    }

    /// Stop tracking a closed tab.
    public func forget(_ url: URL) {
        synced[url.standardizedFileURL] = nil
    }

    /// Compare each open file's current revision to its baseline and return the ones that
    /// changed underneath us, updating the baselines as it goes. Files without a baseline are
    /// skipped — seeding is `seed`'s job (a freshly opened tab is seeded when its text is read),
    /// never reconcile's, so an unseen file is never mistaken for an external change.
    public func reconcile(open urls: [URL]) -> [FileChange] {
        var changes: [FileChange] = []
        for url in urls {
            let key = url.standardizedFileURL
            guard let baseline = synced[key] else { continue }  // not tracked yet
            let current = revisionOf(key)
            switch (baseline, current) {
            case let (.some(was), .some(now)) where was != now:
                synced[key] = .some(now)
                changes.append(.modified(key))
            case (.some, .none):
                synced[key] = .some(nil)
                changes.append(.deleted(key))
            case (.none, .some):
                // Was absent, now back (recreated externally) — treat as a modification.
                synced[key] = current
                changes.append(.modified(key))
            default:
                break  // unchanged, or still-absent
            }
        }
        return changes
    }
}
