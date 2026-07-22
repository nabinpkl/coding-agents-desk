import CoreGraphics
import Foundation
import TerminalEmulator
import PtyTerminalWebView
import XCTest
@testable import AgentDeskHost

@MainActor
final class TerminalWindowPresentationStoreTests: XCTestCase {
    func testRoundTripContainsPresentationMetadataOnly() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let descriptor = TerminalWindowPresentationDescriptor(
            id: UUID(),
            sessionName: "workspace-123",
            workspaceID: UUID(),
            frame: TerminalWindowFrame(CGRect(x: 20, y: 30, width: 700, height: 460)),
            cascadeOrdinal: 2,
            workspaceLabel: "Project"
        )

        try fixture.store.upsert(descriptor)

        XCTAssertEqual(TerminalWindowPresentationStore(url: fixture.url).descriptors, [descriptor])
        let persisted = try Data(contentsOf: fixture.url)
        XCTAssertFalse(persisted.contains(Data("typed-password".utf8)))
        XCTAssertFalse(persisted.contains(Data("\u{1b}[31m".utf8)))
    }

    func testRemoveDeletesOnlySelectedPresentation() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = descriptor(session: "first")
        let second = descriptor(session: "second")
        try fixture.store.upsert(first)
        try fixture.store.upsert(second)

        try fixture.store.remove(id: first.id)

        XCTAssertEqual(fixture.store.descriptors, [second])
    }

    func testPresentationCountIsBounded() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }

        for index in 0...TerminalWindowPresentationStore.maximumPresentations {
            try fixture.store.upsert(descriptor(session: "session-\(index)"))
        }

        XCTAssertEqual(
            fixture.store.descriptors.count,
            TerminalWindowPresentationStore.maximumPresentations
        )
        XCTAssertEqual(fixture.store.descriptors.first?.sessionName, "session-1")
    }

    func testLegacySingleSessionDocumentMigratesToWorkspaceEncoding() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        let id = UUID()
        let legacy = """
        {"presentations":[{"id":"\(id.uuidString)","sessionName":"legacy","frame":{"x":1,"y":2,"width":700,"height":460},"cascadeOrdinal":0,"workspaceLabel":"Legacy"}]}
        """
        try Data(legacy.utf8).write(to: fixture.url)

        let migrated = TerminalWindowPresentationStore(url: fixture.url)
        XCTAssertEqual(migrated.descriptors.first?.sessionNames, ["legacy"])
        try migrated.upsert(try XCTUnwrap(migrated.descriptors.first))
        let persisted = try String(contentsOf: fixture.url, encoding: .utf8)
        XCTAssertTrue(persisted.contains("\"workspace\""))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(persisted.utf8)) as? [String: Any]
        )
        let presentations = try XCTUnwrap(object["presentations"] as? [[String: Any]])
        XCTAssertNil(presentations.first?["sessionName"])
    }

    private func descriptor(session: String) -> TerminalWindowPresentationDescriptor {
        TerminalWindowPresentationDescriptor(
            id: UUID(),
            sessionName: session,
            workspaceID: nil,
            frame: TerminalWindowFrame(CGRect(x: 0, y: 0, width: 700, height: 460)),
            cascadeOrdinal: 0,
            workspaceLabel: session
        )
    }
}

@MainActor
private struct Fixture {
    let directory: URL
    let url: URL
    let store: TerminalWindowPresentationStore

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("terminal-presentations-\(UUID().uuidString)", isDirectory: true)
        url = directory.appendingPathComponent("presentations.json")
        store = TerminalWindowPresentationStore(url: url)
    }

    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}
