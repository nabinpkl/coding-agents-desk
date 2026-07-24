import Foundation
import Testing

struct WorkspaceStoreTests {
    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func directory(named name: String, in parent: URL) throws -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func donorData(workspaces: [(UUID, URL, String)], activeID: UUID? = nil) throws -> Data {
        struct DonorWorkspace: Encodable {
            let id: UUID
            let root: URL
            let name: String
            let lastMode = "editor"
            let sidebarPinned = false
            let topBarPinned = false
        }
        struct DonorStore: Encodable {
            let workspaces: [DonorWorkspace]
            let activeID: UUID?
            let recentOrder: [UUID]
        }

        return try JSONEncoder().encode(DonorStore(
            workspaces: workspaces.map { DonorWorkspace(id: $0.0, root: $0.1, name: $0.2) },
            activeID: activeID,
            recentOrder: workspaces.map(\.0)
        ))
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    @Test func applicationSupportRootRemainsBundleScoped() {
        let expectedRoot = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Config.bundleIdentifier, isDirectory: true)

        #expect(Config.applicationSupportDirectory == expectedRoot)
        #expect(
            Config.workspaceStoreURL ==
                expectedRoot.appendingPathComponent("workspaces.json", isDirectory: false)
        )
    }

    @Test func desktopAssignmentIdentityNeverFallsBackToDisplayAndOrdinal() {
        let assigned = WorkspaceDesktopAssignment(spaceID: 10, displayID: "D1", ordinal: 1)

        #expect(assigned.matches(WorkspaceDesktopAssignment(spaceID: 10, displayID: "D2", ordinal: 0)))
        #expect(!assigned.matches(WorkspaceDesktopAssignment(spaceID: 99, displayID: "D1", ordinal: 1)))
    }

    @Test func topologyReconciliationMovesKnownSpacesAndRetainsMissingAssignments() {
        let movedID = UUID()
        let missingID = UUID()
        var store = WorkspaceStore(
            workspaces: [
                Workspace(
                    id: movedID,
                    root: URL(fileURLWithPath: "/tmp/moved", isDirectory: true),
                    name: "Moved",
                    desktopAssignment: WorkspaceDesktopAssignment(spaceID: 10, displayID: "D1", ordinal: 0)
                ),
                Workspace(
                    id: missingID,
                    root: URL(fileURLWithPath: "/tmp/missing", isDirectory: true),
                    name: "Missing",
                    desktopAssignment: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
                ),
            ]
        )

        store.reconcileDesktopAssignments([
            10: WorkspaceDesktopAssignment(spaceID: 10, displayID: "D2", ordinal: 3),
        ])

        #expect(store.workspace(id: movedID)?.desktopAssignment == WorkspaceDesktopAssignment(
            spaceID: 10,
            displayID: "D2",
            ordinal: 3
        ))
        #expect(store.workspace(id: missingID)?.desktopAssignment == WorkspaceDesktopAssignment(
            spaceID: 20,
            displayID: "D1",
            ordinal: 1
        ))
    }

    @Test func registrationStandardizesRootsAndPreservesOrderAndActiveWorkspace() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let alpha = try self.directory(named: "alpha", in: directory)
        let beta = try self.directory(named: "beta", in: directory)
        let dottedAlpha = alpha.deletingLastPathComponent()
            .appendingPathComponent("alpha/./", isDirectory: true)

        let store = try WorkspaceStore()
            .registering(root: dottedAlpha, name: "Alpha")
            .registering(root: beta, name: "Beta")
        let decoded = try JSONDecoder().decode(WorkspaceStore.self, from: JSONEncoder().encode(store))

        #expect(decoded == store)
        #expect(store.workspaces.map(\.root) == [alpha.standardizedFileURL, beta.standardizedFileURL])
        #expect(store.active?.name == "Beta")
    }

    @Test func registrationRejectsDotSegmentDuplicateRoot() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = try self.directory(named: "project", in: directory)
        let dottedRoot = root.deletingLastPathComponent()
            .appendingPathComponent("project/./", isDirectory: true)
        let store = try WorkspaceStore().registering(root: root, name: "Project")

        #expect(throws: WorkspaceStoreError.duplicateWorkspaceRoot(root.standardizedFileURL)) {
            try store.registering(root: dottedRoot, name: "Duplicate")
        }
    }

    @Test func missingDonorReturnsCleanEmptyStoreWithoutWritingDestination() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let repository = WorkspaceRepository(donorURL: donor, destinationURL: destination)

        let store = try await repository.load()

        #expect(store.workspaces.isEmpty)
        #expect(FileManager.default.fileExists(atPath: destination.path) == false)
    }

    @Test func missingDonorRootFailsWithoutWritingDestinationOrChangingDonor() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let missingRoot = directory.appendingPathComponent("missing", isDirectory: true)
        let original = try donorData(workspaces: [(UUID(), missingRoot, "Missing")])
        try write(original, to: donor)

        await #expect(throws: WorkspaceStoreError.workspaceRootDoesNotExist(missingRoot.standardizedFileURL)) {
            try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()
        }
        #expect(try Data(contentsOf: donor) == original)
        #expect(FileManager.default.fileExists(atPath: destination.path) == false)
    }

    @Test func regularFileDonorRootFailsWithoutWritingDestinationOrChangingDonor() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let fileRoot = directory.appendingPathComponent("not-a-directory")
        try Data("file".utf8).write(to: fileRoot)
        let original = try donorData(workspaces: [(UUID(), fileRoot, "File")])
        try write(original, to: donor)

        await #expect(throws: WorkspaceStoreError.workspaceRootIsNotDirectory(fileRoot.standardizedFileURL)) {
            try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()
        }
        #expect(try Data(contentsOf: donor) == original)
        #expect(FileManager.default.fileExists(atPath: destination.path) == false)
    }

    @Test func symlinkDonorRootFailsWithoutWritingDestinationOrChangingDonor() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let target = try self.directory(named: "target", in: directory)
        let symlink = directory.appendingPathComponent("project-link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: target)
        let original = try donorData(workspaces: [(UUID(), symlink, "Link")])
        try write(original, to: donor)

        await #expect(throws: WorkspaceStoreError.symbolicLinkWorkspaceRoot(symlink.standardizedFileURL)) {
            try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()
        }
        #expect(try Data(contentsOf: donor) == original)
        #expect(FileManager.default.fileExists(atPath: destination.path) == false)
    }

    @Test func importsStableIdentityInDonorOrderAndLeavesDonorUntouched() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let alpha = try self.directory(named: "alpha", in: directory)
        let beta = try self.directory(named: "beta", in: directory)
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let alphaID = UUID()
        let betaID = UUID()
        let original = try donorData(workspaces: [
            (alphaID, alpha, "Alpha"),
            (betaID, beta, "Beta"),
        ], activeID: betaID)
        try write(original, to: donor)

        let imported = try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()

        #expect(imported.workspaces.map(\.id) == [alphaID, betaID])
        #expect(imported.workspaces.map(\.root) == [alpha.standardizedFileURL, beta.standardizedFileURL])
        #expect(imported.workspaces.map(\.name) == ["Alpha", "Beta"])
        #expect(imported.activeID == nil)
        #expect(try Data(contentsOf: donor) == original)
    }

    @Test func existingDestinationAndDifferentValidDonorRemainByteForByteUnchanged() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let existingRoot = try self.directory(named: "existing", in: directory)
        let donorRoot = try self.directory(named: "donor", in: directory)
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let existing = try WorkspaceStore().registering(root: existingRoot, name: "Existing")
        let destinationBytes = try JSONEncoder().encode(existing)
        let donorBytes = try donorData(workspaces: [(UUID(), donorRoot, "Donor")])
        try write(destinationBytes, to: destination)
        try write(donorBytes, to: donor)

        let loaded = try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()

        #expect(loaded == existing)
        #expect(try Data(contentsOf: destination) == destinationBytes)
        #expect(try Data(contentsOf: donor) == donorBytes)
    }

    @Test func corruptDestinationDoesNotFallBackToDonor() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let donorRoot = try self.directory(named: "donor", in: directory)
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destinationBytes = Data("corrupt destination".utf8)
        let donorBytes = try donorData(workspaces: [(UUID(), donorRoot, "Donor")])
        try write(destinationBytes, to: destination)
        try write(donorBytes, to: donor)

        await #expect(throws: Error.self) {
            try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()
        }
        #expect(try Data(contentsOf: destination) == destinationBytes)
        #expect(try Data(contentsOf: donor) == donorBytes)
    }

    @Test func malformedRequiredDonorFieldsFailWithoutWritingDestination() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let original = Data("{\"workspaces\":[{\"id\":\"\(UUID().uuidString)\",\"name\":\"Missing root\"}]}".utf8)
        try write(original, to: donor)

        await #expect(throws: Error.self) {
            try await WorkspaceRepository(donorURL: donor, destinationURL: destination).load()
        }
        #expect(try Data(contentsOf: donor) == original)
        #expect(FileManager.default.fileExists(atPath: destination.path) == false)
    }

    @Test func persistedStoreAllowsUnavailableRootButRejectsUnknownActiveID() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = try self.directory(named: "project", in: directory)
        let store = try WorkspaceStore().registering(root: root, name: "Project")
        try FileManager.default.removeItem(at: root)

        let decoded = try JSONDecoder().decode(WorkspaceStore.self, from: JSONEncoder().encode(store))

        #expect(decoded == store)

        let unknownID = UUID()
        let unknownActiveJSON = Data("""
        {"workspaces":[{"id":"\(store.workspaces[0].id.uuidString)","root":"\(store.workspaces[0].root.absoluteString)","name":"Project"}],"activeID":"\(unknownID.uuidString)"}
        """.utf8)
        #expect(throws: WorkspaceStoreError.unknownActiveWorkspace(unknownID)) {
            try JSONDecoder().decode(WorkspaceStore.self, from: unknownActiveJSON)
        }
    }

    @Test func concurrentRepositoryLoadsCannotOverwriteAuthoritativeDestination() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let existingRoot = try self.directory(named: "existing", in: directory)
        let donorRoot = try self.directory(named: "donor", in: directory)
        let destination = directory.appendingPathComponent("AgentDesk/workspaces.json")
        let donor = directory.appendingPathComponent("AWI/workspace.json")
        let authoritative = try WorkspaceStore().registering(root: existingRoot, name: "Existing")
        let destinationBytes = try JSONEncoder().encode(authoritative)
        let donorBytes = try donorData(workspaces: [(UUID(), donorRoot, "Donor")])
        try write(destinationBytes, to: destination)
        try write(donorBytes, to: donor)
        let repository = WorkspaceRepository(donorURL: donor, destinationURL: destination)

        async let first = repository.load()
        async let second = repository.load()
        let (firstStore, secondStore) = try await (first, second)

        #expect(firstStore == authoritative)
        #expect(secondStore == authoritative)
        #expect(try Data(contentsOf: destination) == destinationBytes)
        #expect(try Data(contentsOf: donor) == donorBytes)
    }
}
