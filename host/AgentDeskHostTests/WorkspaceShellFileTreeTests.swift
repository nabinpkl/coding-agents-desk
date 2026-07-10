import Foundation
import Testing

@testable import AgentDeskHost

struct WorkspaceShellFileTreeTests {
    @Test func orderingIsDirectoriesFirstAndDeterministic() {
        let root = URL(fileURLWithPath: "/workspace")
        let reader = RecordingDirectoryReader(entries: [
            root: [
                WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("z.swift"), isDirectory: false),
                WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("Beta"), isDirectory: true),
                WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("alpha"), isDirectory: true),
                WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("A.swift"), isDirectory: false),
                WorkspaceShellDirectoryEntry(url: root.appendingPathComponent(".git"), isDirectory: true),
            ],
        ])
        let tree = WorkspaceShellFileTree(workspaceID: UUID(), root: root, reader: reader)

        let ordered = tree.rootNode.children()

        #expect(ordered.map(\.name) == ["alpha", "Beta", "A.swift", "z.swift"])
    }

    @Test func childrenLoadLazilyAndRefreshOnlyLoadedDirectories() throws {
        let root = URL(fileURLWithPath: "/workspace")
        let reader = RecordingDirectoryReader(entries: [
            root: [WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("Sources"), isDirectory: true)],
        ])
        let tree = WorkspaceShellFileTree(workspaceID: UUID(), root: root, reader: reader)
        let node = tree.rootNode

        node.refreshLoadedChildren()
        #expect(reader.requests.isEmpty)

        let firstChild = try #require(node.children().first)
        #expect(reader.requests == [root])

        reader.entries[root] = [
            WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("Sources"), isDirectory: true),
            WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("README.md"), isDirectory: false),
        ]
        node.refreshLoadedChildren()

        #expect(reader.requests == [root, root])
        #expect(node.children().map(\.name) == ["Sources", "README.md"])
        #expect(node.children().first === firstChild)
        #expect(firstChild.relativePath.value == "Sources")
    }

    @Test func fileNodesNeverAskTheReaderForChildren() {
        let root = URL(fileURLWithPath: "/workspace")
        let reader = RecordingDirectoryReader(entries: [:])
        let tree = WorkspaceShellFileTree(
            workspaceID: UUID(),
            root: root,
            reader: reader
        )
        reader.entries[root] = [
            WorkspaceShellDirectoryEntry(url: root.appendingPathComponent("main.swift"), isDirectory: false),
        ]
        let node = tree.rootNode.children()[0]

        #expect(node.children().isEmpty)
        node.refreshLoadedChildren()
        #expect(reader.requests == [root])
    }

    @Test func treeRejectsAbsoluteAndEscapingRelativePaths() throws {
        let tree = WorkspaceShellFileTree(
            workspaceID: UUID(),
            root: URL(fileURLWithPath: "/workspace"),
            reader: RecordingDirectoryReader(entries: [:])
        )

        #expect(throws: WorkspaceShellFileTreePathError.absolutePath("/tmp/outside")) {
            try tree.relativePath(for: "/tmp/outside")
        }
        #expect(throws: WorkspaceShellFileTreePathError.escapesRoot("../outside")) {
            try tree.relativePath(for: "../outside")
        }
        #expect(try tree.relativePath(for: "Sources/./App.swift").value == "Sources/App.swift")
    }

    @Test func treeRejectsCrossRootEntriesAndNeverExpandsSymlinks() {
        let root = URL(fileURLWithPath: "/workspace")
        let outside = URL(fileURLWithPath: "/outside/secrets.txt")
        let symlink = root.appendingPathComponent("linked-project")
        var rejections: [WorkspaceShellFileTreeEntryRejection] = []
        let reader = RecordingDirectoryReader(entries: [
            root: [
                WorkspaceShellDirectoryEntry(url: outside, isDirectory: false),
                WorkspaceShellDirectoryEntry(url: symlink, isDirectory: true, isSymbolicLink: true),
            ],
        ])
        let tree = WorkspaceShellFileTree(
            workspaceID: UUID(),
            root: root,
            reader: reader,
            onRejectedEntry: { rejections.append($0) }
        )

        let nodes = tree.rootNode.children()

        #expect(nodes.count == 1)
        #expect(nodes[0].relativePath.value == "linked-project")
        #expect(nodes[0].isSymbolicLink)
        #expect(!nodes[0].isDirectory)
        #expect(nodes[0].children().isEmpty)
        #expect(reader.requests == [root])
        #expect(rejections == [.outsideRoot(outside.standardizedFileURL)])
    }
}

private final class RecordingDirectoryReader: WorkspaceShellDirectoryReading {
    var entries: [URL: [WorkspaceShellDirectoryEntry]]
    private(set) var requests: [URL] = []

    init(entries: [URL: [WorkspaceShellDirectoryEntry]]) {
        self.entries = entries
    }

    func entries(at url: URL) throws -> [WorkspaceShellDirectoryEntry] {
        requests.append(url)
        return entries[url] ?? []
    }
}
