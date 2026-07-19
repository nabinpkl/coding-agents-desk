import AgentDeskWire
import Foundation
import Testing
@testable import WorkspaceIDE

@Test func draftsRoundTripAndRemoveAtomically() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WorkspaceIDEFileDraftStore(directory: directory)
    let draft = WorkspaceIDEDraft(
        workspaceID: "workspace-1",
        path: "Sources/App.swift",
        text: "print(1)",
        baselineRevision: WorkspaceFileRevision(digest: "baseline"),
        updatedAt: Date(timeIntervalSince1970: 1)
    )

    try store.save(draft)
    #expect(try store.draft(workspaceID: draft.workspaceID, path: draft.path) == draft)
    try store.remove(workspaceID: draft.workspaceID, path: draft.path)
    #expect(try store.draft(workspaceID: draft.workspaceID, path: draft.path) == nil)
}
