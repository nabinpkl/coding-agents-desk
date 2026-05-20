import Foundation
import Testing

struct LaunchAgentInstallerTests {
    @Test func installWritesExpectedPlist() throws {
        let fixture = try LaunchAgentFixture()

        try fixture.installer.installIfNeeded()
        let plist = try fixture.readPlist()

        #expect(plist["Label"] as? String == fixture.label)
        #expect(plist["ProgramArguments"] as? [String] == [fixture.executableURL.path])
        #expect(plist["RunAtLoad"] as? Bool == true)
        #expect(plist["KeepAlive"] as? Bool == false)
        #expect(plist["ProcessType"] as? String == "Interactive")
        #expect(plist["LimitLoadToSessionType"] as? String == "Aqua")
    }

    @Test func installIsIdempotentWhenPlistMatches() throws {
        let fixture = try LaunchAgentFixture()

        try fixture.installer.installIfNeeded()
        let sentinelDate = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: sentinelDate], ofItemAtPath: fixture.plistURL.path)
        try fixture.installer.installIfNeeded()

        #expect(try fixture.plistWriteDate() == sentinelDate)
        #expect(fixture.runner.bootstrapCalls == [fixture.plistURL])
        #expect(fixture.runner.bootoutCalls.isEmpty)
    }

    @Test func installOverwritesStalePlistAndReloads() throws {
        let fixture = try LaunchAgentFixture()
        try FileManager.default.createDirectory(
            at: fixture.plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let stale = ["Label": "stale.label"]
        let staleData = try PropertyListSerialization.data(fromPropertyList: stale, format: .xml, options: 0)
        try staleData.write(to: fixture.plistURL, options: .atomic)

        try fixture.installer.installIfNeeded()

        let plist = try fixture.readPlist()
        #expect(plist["Label"] as? String == fixture.label)
        #expect(fixture.runner.bootoutCalls == [fixture.label])
        #expect(fixture.runner.bootstrapCalls == [fixture.plistURL])
    }

    @Test func uninstallRemovesPlistAndBootsOut() throws {
        let fixture = try LaunchAgentFixture()
        try fixture.installer.installIfNeeded()

        try fixture.installer.uninstall()

        #expect(!FileManager.default.fileExists(atPath: fixture.plistURL.path))
        #expect(fixture.runner.bootoutCalls == [fixture.label])
    }

    @Test func isLoadedReturnsRunnerListResult() throws {
        let fixture = try LaunchAgentFixture()
        fixture.runner.loaded = true

        #expect(try fixture.installer.isLoaded())

        fixture.runner.loaded = false
        #expect(!(try fixture.installer.isLoaded()))
        #expect(fixture.runner.listCalls == [fixture.label, fixture.label])
    }
}

private final class FakeLaunchctlRunner: LaunchctlRunning {
    var bootstrapCalls: [URL] = []
    var bootoutCalls: [String] = []
    var listCalls: [String] = []
    var loaded = false

    func bootstrap(plistURL: URL) throws {
        bootstrapCalls.append(plistURL)
        loaded = true
    }

    func bootout(label: String) throws {
        bootoutCalls.append(label)
        loaded = false
    }

    func list(label: String) throws -> Bool {
        listCalls.append(label)
        return loaded
    }
}

private struct LaunchAgentFixture {
    let directory: URL
    let plistURL: URL
    let executableURL: URL
    let label = "com.example.agentdesk.AgentDeskHost.tests"
    let runner: FakeLaunchctlRunner
    let installer: LaunchAgentInstaller

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        plistURL = directory.appendingPathComponent("com.example.agentdesk.AgentDeskHost.tests.plist")
        executableURL = directory.appendingPathComponent("AgentDeskHost")
        runner = FakeLaunchctlRunner()
        installer = LaunchAgentInstaller(
            plistURL: plistURL,
            executableURL: executableURL,
            label: label,
            runner: runner
        )
    }

    func readPlist() throws -> [String: Any] {
        let data = try Data(contentsOf: plistURL)
        let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        return try #require(value as? [String: Any])
    }

    func plistWriteDate() throws -> Date {
        let values = try plistURL.resourceValues(forKeys: [.contentModificationDateKey])
        return try #require(values.contentModificationDate)
    }
}
