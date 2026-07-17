import Foundation

protocol DockDesktopSwapExecuting: Sendable {
    func swap(sourceSpaceID: UInt64, destinationSpaceID: UInt64) async throws -> DockDesktopSwapReceipt
    func undo(_ receipt: DockDesktopSwapReceipt) async throws -> DockDesktopUndoResult
}

struct DockDesktopSwapReceipt: Equatable, Sendable {
    let sourceSpaceID: UInt64
    let destinationSpaceID: UInt64
    let sourceWindowIDs: [UInt32]
    let destinationWindowIDs: [UInt32]
}

struct DockDesktopUndoResult: Equatable, Sendable {
    let restoredWindowIDs: [UInt32]
    let skippedWindowIDs: [UInt32]
}

enum DockDesktopSwapError: Error, LocalizedError, Sendable {
    case sameSpace
    case spaceNotFound(UInt64)
    case nativeFullscreenSpace(UInt64)
    case invalidSnapshot(String)
    case commandFailed(arguments: [String], message: String)
    case verificationFailed(windowIDs: [UInt32])
    case rollbackFailed(cause: String, windowIDs: [UInt32])

    var rollbackFailedWindowIDs: [UInt32] {
        guard case .rollbackFailed(_, let windowIDs) = self else { return [] }
        return windowIDs
    }

    var errorDescription: String? {
        switch self {
        case .sameSpace:
            return "Choose two different Desktops"
        case .spaceNotFound(let id):
            return "Desktop Space \(id) is no longer available"
        case .nativeFullscreenSpace(let id):
            return "Fullscreen Space \(id) cannot be swapped"
        case .invalidSnapshot(let reason):
            return "yabai returned invalid state: \(reason)"
        case .commandFailed(let arguments, let message):
            return "yabai \(arguments.joined(separator: " ")) failed: \(message)"
        case .verificationFailed(let windowIDs):
            return "Desktop swap could not verify windows \(Self.idList(windowIDs))"
        case .rollbackFailed(let cause, let windowIDs):
            return "Desktop swap failed (\(cause)) and rollback could not restore windows \(Self.idList(windowIDs))"
        }
    }

    private static func idList(_ values: [UInt32]) -> String {
        values.map(String.init).joined(separator: ", ")
    }
}

struct DockDesktopSwapExecutor: DockDesktopSwapExecuting {
    private let commandRunner: any YabaiCommandRunning

    init(
        commandRunner: any YabaiCommandRunning = YabaiProcessCommandRunner(
            executableURL: Config.yabaiURL,
            timeout: Config.yabaiCommandTimeoutSeconds
        )
    ) {
        self.commandRunner = commandRunner
    }

    func swap(sourceSpaceID: UInt64, destinationSpaceID: UInt64) async throws -> DockDesktopSwapReceipt {
        guard sourceSpaceID != destinationSpaceID else {
            throw DockDesktopSwapError.sameSpace
        }
        let before = try await snapshot()
        let source = try before.userSpace(id: sourceSpaceID)
        let destination = try before.userSpace(id: destinationSpaceID)
        let sourceWindows = before.eligibleWindows(in: source.index)
        let destinationWindows = before.eligibleWindows(in: destination.index)
        let moves = destinationWindows.map {
            WindowMove(windowID: $0.id, originalSpaceID: destination.id, targetSpaceID: source.id)
        } + sourceWindows.map {
            WindowMove(windowID: $0.id, originalSpaceID: source.id, targetSpaceID: destination.id)
        }

        try await performTransaction(moves)
        return DockDesktopSwapReceipt(
            sourceSpaceID: source.id,
            destinationSpaceID: destination.id,
            sourceWindowIDs: sourceWindows.map(\.id),
            destinationWindowIDs: destinationWindows.map(\.id)
        )
    }

    func undo(_ receipt: DockDesktopSwapReceipt) async throws -> DockDesktopUndoResult {
        let current = try await snapshot()
        let source = try current.userSpace(id: receipt.sourceSpaceID)
        let destination = try current.userSpace(id: receipt.destinationSpaceID)
        let windowsByID = current.windowsByID
        var skipped: [UInt32] = []
        var moves: [WindowMove] = []

        for id in receipt.sourceWindowIDs {
            guard windowsByID[id]?.space == destination.index else {
                skipped.append(id)
                continue
            }
            moves.append(WindowMove(windowID: id, originalSpaceID: destination.id, targetSpaceID: source.id))
        }
        for id in receipt.destinationWindowIDs {
            guard windowsByID[id]?.space == source.index else {
                skipped.append(id)
                continue
            }
            moves.append(WindowMove(windowID: id, originalSpaceID: source.id, targetSpaceID: destination.id))
        }

        try await performTransaction(moves)
        return DockDesktopUndoResult(
            restoredWindowIDs: moves.map(\.windowID).sorted(),
            skippedWindowIDs: skipped.sorted()
        )
    }

    private func performTransaction(_ moves: [WindowMove]) async throws {
        guard !moves.isEmpty else { return }
        var completed: [WindowMove] = []
        do {
            let spaces = try await querySpaces()
            for move in moves {
                let target = try spaces.userSpace(id: move.targetSpaceID)
                _ = try await run(["-m", "window", String(move.windowID), "--space", String(target.index)])
                completed.append(move)
            }
            try await verify(moves)
        } catch {
            let original = normalized(error)
            let rollbackFailures = await rollback(completed)
            guard rollbackFailures.isEmpty else {
                throw DockDesktopSwapError.rollbackFailed(
                    cause: original.localizedDescription,
                    windowIDs: rollbackFailures
                )
            }
            throw original
        }
    }

    private func verify(_ moves: [WindowMove]) async throws {
        let current = try await snapshot()
        var failed: [UInt32] = []
        for move in moves {
            let target = try current.userSpace(id: move.targetSpaceID)
            if current.windowsByID[move.windowID]?.space != target.index {
                failed.append(move.windowID)
            }
        }
        guard failed.isEmpty else {
            throw DockDesktopSwapError.verificationFailed(windowIDs: failed.sorted())
        }
    }

    private func rollback(_ completed: [WindowMove]) async -> [UInt32] {
        guard !completed.isEmpty else { return [] }
        let spaces: [YabaiSpace]
        do {
            spaces = try await querySpaces()
        } catch {
            return completed.map(\.windowID).sorted()
        }

        var commandFailures = Set<UInt32>()
        for move in completed.reversed() {
            do {
                let original = try spaces.userSpace(id: move.originalSpaceID)
                _ = try await run(["-m", "window", String(move.windowID), "--space", String(original.index)])
            } catch {
                commandFailures.insert(move.windowID)
            }
        }

        do {
            let after = try await snapshot()
            for move in completed {
                let original = try after.userSpace(id: move.originalSpaceID)
                if after.windowsByID[move.windowID]?.space != original.index {
                    commandFailures.insert(move.windowID)
                }
            }
        } catch {
            return completed.map(\.windowID).sorted()
        }
        return commandFailures.sorted()
    }

    private func snapshot() async throws -> YabaiSnapshot {
        let spaces = try await querySpaces()
        let windowsData = try await run(["-m", "query", "--windows"])
        let windows: [YabaiWindow] = try decode(windowsData, name: "windows")
        return try YabaiSnapshot(spaces: spaces, windows: windows)
    }

    private func querySpaces() async throws -> [YabaiSpace] {
        let data = try await run(["-m", "query", "--spaces"])
        let spaces: [YabaiSpace] = try decode(data, name: "spaces")
        _ = try YabaiSnapshot(spaces: spaces, windows: [])
        return spaces
    }

    private func run(_ arguments: [String]) async throws -> Data {
        do {
            return try await commandRunner.run(arguments: arguments)
        } catch let error as DockDesktopSwapError {
            throw error
        } catch {
            throw DockDesktopSwapError.commandFailed(
                arguments: arguments,
                message: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            )
        }
    }

    private func decode<Value: Decodable>(_ data: Data, name: String) throws -> Value {
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            throw DockDesktopSwapError.invalidSnapshot("\(name): \(String(describing: error))")
        }
    }

    private func normalized(_ error: Error) -> DockDesktopSwapError {
        if let error = error as? DockDesktopSwapError { return error }
        return .invalidSnapshot(error.localizedDescription)
    }
}

private struct WindowMove: Equatable, Sendable {
    let windowID: UInt32
    let originalSpaceID: UInt64
    let targetSpaceID: UInt64
}

private struct YabaiSnapshot: Sendable {
    let spaces: [YabaiSpace]
    let windows: [YabaiWindow]
    let windowsByID: [UInt32: YabaiWindow]

    init(spaces: [YabaiSpace], windows: [YabaiWindow]) throws {
        guard Set(spaces.map(\.id)).count == spaces.count else {
            throw DockDesktopSwapError.invalidSnapshot("duplicate Space id")
        }
        guard Set(spaces.map(\.index)).count == spaces.count else {
            throw DockDesktopSwapError.invalidSnapshot("duplicate Space index")
        }
        guard spaces.allSatisfy({ $0.id > 0 && $0.index > 0 }) else {
            throw DockDesktopSwapError.invalidSnapshot("non-positive Space identity")
        }
        guard Set(windows.map(\.id)).count == windows.count else {
            throw DockDesktopSwapError.invalidSnapshot("duplicate window id")
        }
        self.spaces = spaces
        self.windows = windows
        windowsByID = Dictionary(uniqueKeysWithValues: windows.map { ($0.id, $0) })
    }

    func userSpace(id: UInt64) throws -> YabaiSpace {
        guard let space = spaces.first(where: { $0.id == id }) else {
            throw DockDesktopSwapError.spaceNotFound(id)
        }
        guard !space.isNativeFullscreen else {
            throw DockDesktopSwapError.nativeFullscreenSpace(id)
        }
        return space
    }

    func eligibleWindows(in spaceIndex: Int) -> [YabaiWindow] {
        windows.filter { window in
            window.space == spaceIndex &&
                !window.isMinimized &&
                !window.isHidden &&
                !window.isSticky &&
                !window.isNativeFullscreen
        }.sorted { $0.id < $1.id }
    }
}

private struct YabaiSpace: Decodable, Sendable {
    let id: UInt64
    let index: Int
    let display: Int
    let isNativeFullscreen: Bool

    enum CodingKeys: String, CodingKey {
        case id, index, display
        case isNativeFullscreen = "is-native-fullscreen"
    }
}

private struct YabaiWindow: Decodable, Sendable {
    let id: UInt32
    let space: Int
    let isMinimized: Bool
    let isHidden: Bool
    let isSticky: Bool
    let isNativeFullscreen: Bool

    enum CodingKeys: String, CodingKey {
        case id, space
        case isMinimized = "is-minimized"
        case isHidden = "is-hidden"
        case isSticky = "is-sticky"
        case isNativeFullscreen = "is-native-fullscreen"
    }
}

private extension Array where Element == YabaiSpace {
    func userSpace(id: UInt64) throws -> YabaiSpace {
        guard let space = first(where: { $0.id == id }) else {
            throw DockDesktopSwapError.spaceNotFound(id)
        }
        guard !space.isNativeFullscreen else {
            throw DockDesktopSwapError.nativeFullscreenSpace(id)
        }
        return space
    }
}
