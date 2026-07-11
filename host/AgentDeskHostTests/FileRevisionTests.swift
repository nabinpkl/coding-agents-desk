import Foundation
import XCTest

@testable import AgentDeskHost

final class FileRevisionTests: XCTestCase {
    private func tempFile(_ contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("file-revision-\(UUID().uuidString).txt")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testEqualWhenModifiedAndSizeMatch() {
        let date = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(
            FileRevision(modified: date, size: 42),
            FileRevision(modified: date, size: 42)
        )
    }

    func testUnequalWhenSizeDiffers() {
        let date = Date(timeIntervalSince1970: 1_000)
        XCTAssertNotEqual(
            FileRevision(modified: date, size: 42),
            FileRevision(modified: date, size: 43)
        )
    }

    func testUnequalWhenModifiedDiffers() {
        XCTAssertNotEqual(
            FileRevision(modified: Date(timeIntervalSince1970: 1_000), size: 42),
            FileRevision(modified: Date(timeIntervalSince1970: 2_000), size: 42)
        )
    }

    func testOfReturnsNilForMissingFile() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("does-not-exist-\(UUID().uuidString)")
        XCTAssertNil(FileRevision.of(missing))
    }

    func testOfReturnsRevisionForExistingFile() throws {
        let url = try tempFile("hello")
        defer { try? FileManager.default.removeItem(at: url) }
        let revision = FileRevision.of(url)
        XCTAssertNotNil(revision)
        XCTAssertEqual(revision?.size, 5)
    }

    func testOfChangesAfterRewrite() throws {
        let url = try tempFile("hello")
        defer { try? FileManager.default.removeItem(at: url) }
        let before = FileRevision.of(url)
        // A larger rewrite changes the size, so the revision differs regardless of mtime
        // granularity.
        try "hello world, longer now".write(to: url, atomically: true, encoding: .utf8)
        let after = FileRevision.of(url)
        XCTAssertNotNil(before)
        XCTAssertNotNil(after)
        XCTAssertNotEqual(before, after)
    }
}
