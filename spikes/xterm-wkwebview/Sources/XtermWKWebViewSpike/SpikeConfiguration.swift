import Foundation

struct SpikeConfiguration {
    let socketPath: String
    let workingDirectory: String
    let runsBackgroundSelfTest: Bool

    init(arguments: [String]) {
        socketPath = Self.value(after: "--socket", in: arguments) ?? "/tmp/pty-manager.sock"
        workingDirectory = Self.value(after: "--cwd", in: arguments)
            ?? FileManager.default.currentDirectoryPath
        runsBackgroundSelfTest = arguments.contains("--self-test")
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}
