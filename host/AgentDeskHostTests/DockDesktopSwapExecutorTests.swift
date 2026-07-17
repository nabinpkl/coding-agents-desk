import Foundation
import Testing

@testable import AgentDeskHost

struct DockDesktopSwapExecutorTests {
    @Test func swapsOnlyEligibleWindowsDestinationFirstAndVerifies() async throws {
        let runner = ScriptedYabaiCommandRunner([
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 11, space: 1, minimized: true),
                Self.window(id: 12, space: 1, hidden: true),
                Self.window(id: 13, space: 1, sticky: true),
                Self.window(id: 14, space: 1, nativeFullscreen: true),
                Self.window(id: 20, space: 2),
            ])),
            .success(Self.spaces()),
            .success(Data()),
            .success(Data()),
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 2),
                Self.window(id: 11, space: 1, minimized: true),
                Self.window(id: 12, space: 1, hidden: true),
                Self.window(id: 13, space: 1, sticky: true),
                Self.window(id: 14, space: 1, nativeFullscreen: true),
                Self.window(id: 20, space: 1),
            ])),
        ])
        let executor = DockDesktopSwapExecutor(commandRunner: runner)

        let receipt = try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 200)

        #expect(receipt.sourceWindowIDs == [10])
        #expect(receipt.destinationWindowIDs == [20])
        #expect(await runner.commands == [
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
            ["-m", "query", "--spaces"],
            ["-m", "window", "20", "--space", "1"],
            ["-m", "window", "10", "--space", "2"],
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
        ])
    }

    @Test func failedMoveRollsBackCompletedMoves() async throws {
        let runner = ScriptedYabaiCommandRunner([
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 20, space: 2),
            ])),
            .success(Self.spaces()),
            .success(Data()),
            .failure(FakeYabaiError.failed),
            .success(Self.spaces()),
            .success(Data()),
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 20, space: 2),
            ])),
        ])
        let executor = DockDesktopSwapExecutor(commandRunner: runner)

        await #expect(throws: DockDesktopSwapError.self) {
            try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 200)
        }
        #expect(await runner.commands.suffix(4) == [
            ["-m", "query", "--spaces"],
            ["-m", "window", "20", "--space", "2"],
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
        ])
    }

    @Test func rollbackFailureReportsAffectedWindowIDs() async throws {
        let runner = ScriptedYabaiCommandRunner([
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 20, space: 2),
            ])),
            .success(Self.spaces()),
            .success(Data()),
            .failure(FakeYabaiError.failed),
            .success(Self.spaces()),
            .failure(FakeYabaiError.failed),
        ])
        let executor = DockDesktopSwapExecutor(commandRunner: runner)

        do {
            _ = try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 200)
            Issue.record("Expected rollback failure")
        } catch let error as DockDesktopSwapError {
            #expect(error.rollbackFailedWindowIDs == [20])
        }
    }

    @Test func undoRestoresOnlyWindowsStillAtTheirExpectedSwappedDestination() async throws {
        let runner = ScriptedYabaiCommandRunner([
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 20, space: 2),
            ])),
            .success(Self.spaces()),
            .success(Data()),
            .success(Data()),
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 2),
                Self.window(id: 20, space: 1),
            ])),
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 2),
                Self.window(id: 20, space: 3),
                Self.window(id: 30, space: 1),
            ])),
            .success(Self.spaces()),
            .success(Data()),
            .success(Self.spaces()),
            .success(Self.windows([
                Self.window(id: 10, space: 1),
                Self.window(id: 20, space: 3),
                Self.window(id: 30, space: 1),
            ])),
        ])
        let executor = DockDesktopSwapExecutor(commandRunner: runner)
        let receipt = try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 200)

        let result = try await executor.undo(receipt)

        #expect(result.restoredWindowIDs == [10])
        #expect(result.skippedWindowIDs == [20])
        #expect(await runner.commands.suffix(6) == [
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
            ["-m", "query", "--spaces"],
            ["-m", "window", "10", "--space", "1"],
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
        ])
    }

    @Test func sameSpaceAndMalformedSnapshotsFailBeforeMovingWindows() async throws {
        let runner = ScriptedYabaiCommandRunner([
            .success(Self.spaces()),
            .success(Data("not-json".utf8)),
        ])
        let executor = DockDesktopSwapExecutor(commandRunner: runner)

        await #expect(throws: DockDesktopSwapError.self) {
            try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 100)
        }
        await #expect(throws: DockDesktopSwapError.self) {
            try await executor.swap(sourceSpaceID: 100, destinationSpaceID: 200)
        }
        #expect(await runner.commands == [
            ["-m", "query", "--spaces"],
            ["-m", "query", "--windows"],
        ])
    }

    @Test func centralConfigExpandsOverrideAndDefaultsToLocalBin() {
        let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)
        #expect(Config.yabaiURL(environment: [:], homeDirectory: home).path == "/Users/test/.local/bin/yabai")
        #expect(
            Config.yabaiURL(
                environment: ["AGENTDESK_YABAI_PATH": "~/tools/yabai"],
                homeDirectory: home
            ).path == "/Users/test/tools/yabai"
        )
    }

    @Test func processRunnerRejectsMissingExecutableAndTimesOut() async {
        let missing = YabaiProcessCommandRunner(
            executableURL: URL(fileURLWithPath: "/definitely/missing/yabai"),
            timeout: 0.1
        )
        await #expect(throws: YabaiCommandError.self) {
            try await missing.run(arguments: ["--version"])
        }

        let sleeping = YabaiProcessCommandRunner(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            timeout: 0.01
        )
        await #expect(throws: YabaiCommandError.self) {
            try await sleeping.run(arguments: ["1"])
        }
    }

    private static func spaces() -> Data {
        Data("""
        [
          {"id":100,"index":1,"display":1,"is-native-fullscreen":false},
          {"id":200,"index":2,"display":2,"is-native-fullscreen":false},
          {"id":300,"index":3,"display":1,"is-native-fullscreen":false}
        ]
        """.utf8)
    }

    private static func windows(_ values: [String]) -> Data {
        Data("[\(values.joined(separator: ","))]".utf8)
    }

    private static func window(
        id: UInt32,
        space: Int,
        minimized: Bool = false,
        hidden: Bool = false,
        sticky: Bool = false,
        nativeFullscreen: Bool = false
    ) -> String {
        """
        {"id":\(id),"pid":1,"app":"Test","title":"Window \(id)","space":\(space),"display":1,"is-minimized":\(minimized),"is-hidden":\(hidden),"is-sticky":\(sticky),"is-native-fullscreen":\(nativeFullscreen),"has-focus":false,"is-visible":false}
        """
    }
}

private enum FakeYabaiError: Error {
    case failed
}

private actor ScriptedYabaiCommandRunner: YabaiCommandRunning {
    private var responses: [Result<Data, Error>]
    private(set) var commands: [[String]] = []

    init(_ responses: [Result<Data, Error>]) {
        self.responses = responses
    }

    func run(arguments: [String]) async throws -> Data {
        commands.append(arguments)
        guard !responses.isEmpty else {
            throw FakeYabaiError.failed
        }
        return try responses.removeFirst().get()
    }
}
