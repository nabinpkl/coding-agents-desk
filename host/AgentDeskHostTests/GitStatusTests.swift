import Foundation
import XCTest

final class GitStatusTests: XCTestCase {
    private let repo = URL(fileURLWithPath: "/repo")

    private func parse(_ porcelain: String) -> GitStatus {
        GitStatus(byPath: parsePorcelain(porcelain, repoRoot: repo))
    }

    private func file(_ path: String) -> URL { repo.appendingPathComponent(path) }

    // MARK: - Code → status

    func testEachPorcelainCodeMapsToItsStatus() {
        XCTAssertEqual(gitFileStatus(forCode: " M"), .modified)
        XCTAssertEqual(gitFileStatus(forCode: "M "), .modified)
        XCTAssertEqual(gitFileStatus(forCode: "A "), .added)
        XCTAssertEqual(gitFileStatus(forCode: " D"), .deleted)
        XCTAssertEqual(gitFileStatus(forCode: "??"), .untracked)
        XCTAssertEqual(gitFileStatus(forCode: "!!"), .ignored)
        XCTAssertEqual(gitFileStatus(forCode: "UU"), .conflicted)
        XCTAssertEqual(gitFileStatus(forCode: "AA"), .conflicted)
        XCTAssertNil(gitFileStatus(forCode: "  "))
    }

    func testTwoLetterCodeTakesStrongerStatus() {
        // staged modify + worktree delete → the stronger (modified) decorates the row.
        XCTAssertEqual(gitFileStatus(forCode: "MD"), .modified)
    }

    // MARK: - Parsing

    func testParsesEachEntryToAbsolutePathAndStatus() {
        let status = parse(" M src/a.swift\u{0}?? new.txt\u{0}A  staged.txt\u{0}UU merge.txt\u{0}")

        XCTAssertEqual(status.byPath[file("src/a.swift")], .modified)
        XCTAssertEqual(status.byPath[file("new.txt")], .untracked)
        XCTAssertEqual(status.byPath[file("staged.txt")], .added)
        XCTAssertEqual(status.byPath[file("merge.txt")], .conflicted)
        XCTAssertEqual(status.byPath.count, 4)
    }

    func testRenameKeepsNewPathAndSkipsOriginal() {
        // -z emits the destination, then the source as a separate field.
        let status = parse("R  new-name.txt\u{0}old-name.txt\u{0} M other.swift\u{0}")

        XCTAssertEqual(status.byPath[file("new-name.txt")], .modified)
        XCTAssertNil(status.byPath[file("old-name.txt")], "the original path of a rename is not decorated")
        XCTAssertEqual(status.byPath[file("other.swift")], .modified, "the field after a rename's source still parses")
        XCTAssertEqual(status.byPath.count, 2)
    }

    func testEmptyOutputIsNoChanges() {
        XCTAssertTrue(parse("").byPath.isEmpty)
    }

    // MARK: - Folder propagation

    func testFileDecorationIsItsOwnStatus() {
        let status = parse(" M src/a.swift\u{0}")
        XCTAssertEqual(status.decoration(for: file("src/a.swift"), isDirectory: false), .modified)
    }

    func testFolderTakesHighestSeverityDescendant() {
        let status = parse("?? src/notes.txt\u{0} M src/a.swift\u{0}UU src/deep/merge.txt\u{0}")

        // src holds untracked + modified + conflicted → conflicted wins (highest severity).
        XCTAssertEqual(status.decoration(for: file("src"), isDirectory: true), .conflicted)
        // a nested folder only sees its own subtree.
        XCTAssertEqual(status.decoration(for: file("src/deep"), isDirectory: true), .conflicted)
    }

    func testCleanFolderHasNoDecoration() {
        let status = parse(" M src/a.swift\u{0}")
        XCTAssertNil(status.decoration(for: file("docs"), isDirectory: true))
    }

    func testFolderPrefixDoesNotMatchSiblingByNamePrefix() {
        // "src-gen/x" must not count toward the "src" folder's decoration.
        let status = parse(" M src-gen/x.swift\u{0}")
        XCTAssertNil(status.decoration(for: file("src"), isDirectory: true))
    }

    // MARK: - Ignored

    func testIgnoredFolderGreysItselfAndDescendants() {
        // git collapses an ignored dir to one entry; both it and anything inside read ignored.
        let status = parse("!! .build/\u{0}")
        XCTAssertEqual(status.decoration(for: file(".build"), isDirectory: true), .ignored)
        XCTAssertEqual(status.decoration(for: file(".build/app/bin"), isDirectory: true), .ignored)
        XCTAssertEqual(status.decoration(for: file(".build/app/bin/tool"), isDirectory: false), .ignored)
    }

    func testIgnoredDoesNotLeakToSiblingByNamePrefix() {
        // ".build-cache/x" must not inherit ".build"'s ignored decoration.
        let status = parse("!! .build/\u{0}")
        XCTAssertNil(status.decoration(for: file(".build-cache/x"), isDirectory: false))
    }

    func testChangesExcludeIgnored() {
        let status = parse(" M src/a.swift\u{0}!! .build/\u{0}?? new.txt\u{0}")
        XCTAssertEqual(status.byPath.count, 3, "byPath keeps ignored for tree greying")
        XCTAssertEqual(status.changes.count, 2, "changes drop ignored")
        XCTAssertNil(status.changes[file(".build")])
    }
}
