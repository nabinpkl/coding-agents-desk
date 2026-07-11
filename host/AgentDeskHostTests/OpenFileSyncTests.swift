import Foundation
import XCTest

@testable import AgentDeskHost

final class OpenFileSyncTests: XCTestCase {
    /// A fake disk: each URL maps to its current revision (or nil = absent). The tests drive it
    /// directly so no real filesystem is touched.
    private final class FakeDisk {
        var revisions: [URL: FileRevision] = [:]
        func revision(of url: URL) -> FileRevision? { revisions[url.standardizedFileURL] }
    }

    private let a = URL(fileURLWithPath: "/ws/a.txt")
    private let b = URL(fileURLWithPath: "/ws/b.txt")

    private func rev(_ size: Int, _ t: TimeInterval = 0) -> FileRevision {
        FileRevision(modified: Date(timeIntervalSince1970: t), size: size)
    }

    private func makeSync(_ disk: FakeDisk) -> OpenFileSync {
        OpenFileSync(revisionOf: { disk.revision(of: $0) })
    }

    func testSeededUnchangedFileReportsNoChange() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        XCTAssertEqual(sync.reconcile(open: [a]), [])
    }

    func testExternalModificationIsReported() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        disk.revisions[a] = rev(20)  // something rewrote it
        XCTAssertEqual(sync.reconcile(open: [a]), [.modified(a)])
    }

    func testDeletionIsReported() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        disk.revisions[a] = nil  // deleted
        XCTAssertEqual(sync.reconcile(open: [a]), [.deleted(a)])
    }

    func testUnseededFileIsSkipped() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        // Never seeded -> reconcile must not treat it as a change (no baseline to compare).
        XCTAssertEqual(sync.reconcile(open: [a]), [])
    }

    func testForgetStopsTracking() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        sync.forget(a)
        disk.revisions[a] = rev(20)
        XCTAssertEqual(sync.reconcile(open: [a]), [])
    }

    func testReseedSuppressesOurOwnWriteEcho() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        // We wrote the file (size grew); re-seed to the post-write revision (echo suppression).
        disk.revisions[a] = rev(20)
        sync.seed(a)
        // The FolderWatch event our own write triggers must now compare equal -> no change.
        XCTAssertEqual(sync.reconcile(open: [a]), [])
    }

    func testReportsOnlyChangedAmongMany() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        disk.revisions[b] = rev(30)
        let sync = makeSync(disk)
        sync.seed(a)
        sync.seed(b)
        disk.revisions[b] = rev(31)  // only b changed
        XCTAssertEqual(sync.reconcile(open: [a, b]), [.modified(b)])
    }

    func testModificationReportedOnceThenSettles() {
        let disk = FakeDisk()
        disk.revisions[a] = rev(10)
        let sync = makeSync(disk)
        sync.seed(a)
        disk.revisions[a] = rev(20)
        XCTAssertEqual(sync.reconcile(open: [a]), [.modified(a)])
        // Baseline advanced to the new revision, so a second pass with no further change is quiet.
        XCTAssertEqual(sync.reconcile(open: [a]), [])
    }
}
