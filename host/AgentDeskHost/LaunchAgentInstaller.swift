import Foundation

struct LaunchAgentInstaller {
    let plistURL: URL
    let executableURL: URL
    let label: String
    let runner: LaunchctlRunning

    init(plistURL: URL, executableURL: URL, label: String, runner: LaunchctlRunning) {
        self.plistURL = plistURL
        self.executableURL = executableURL
        self.label = label
        self.runner = runner
    }

    func installIfNeeded() throws {
        let expected = expectedPlistDictionary()

        guard FileManager.default.fileExists(atPath: plistURL.path) else {
            try write(expected)
            try runner.bootstrap(plistURL: plistURL)
            return
        }

        if try existingPlistMatches(expected) {
            return
        }

        try write(expected)
        try? runner.bootout(label: label)
        try runner.bootstrap(plistURL: plistURL)
    }

    func uninstall() throws {
        try? runner.bootout(label: label)
        guard FileManager.default.fileExists(atPath: plistURL.path) else {
            return
        }
        try FileManager.default.removeItem(at: plistURL)
    }

    func isLoaded() throws -> Bool {
        try runner.list(label: label)
    }

    private func existingPlistMatches(_ expected: NSDictionary) throws -> Bool {
        let data = try Data(contentsOf: plistURL)
        let propertyList = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        guard let dictionary = propertyList as? NSDictionary else {
            return false
        }
        return dictionary.isEqual(to: expected as! [AnyHashable: Any])
    }

    private func write(_ dictionary: NSDictionary) throws {
        try FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try PropertyListSerialization.data(
            fromPropertyList: dictionary,
            format: .xml,
            options: 0
        )
        try data.write(to: plistURL, options: .atomic)
    }

    private func expectedPlistDictionary() -> NSDictionary {
        [
            "Label": label,
            "ProgramArguments": [executableURL.path],
            "RunAtLoad": true,
            "KeepAlive": false,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua"
        ] as NSDictionary
    }
}

protocol LaunchctlRunning {
    func bootstrap(plistURL: URL) throws
    func bootout(label: String) throws
    func list(label: String) throws -> Bool
}

struct SystemLaunchctlRunner: LaunchctlRunning {
    func bootstrap(plistURL: URL) throws {
        try run(arguments: ["bootstrap", "gui/\(getuid())", plistURL.path])
    }

    func bootout(label: String) throws {
        try run(arguments: ["bootout", "gui/\(getuid())/\(label)"])
    }

    func list(label: String) throws -> Bool {
        do {
            try run(arguments: ["list", label])
            return true
        } catch let error as LaunchctlError where error.status != 0 {
            return false
        }
    }

    private func run(arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let output = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let error = errorPipe.fileHandleForReading.readDataToEndOfFile()
            var combinedOutput = output
            combinedOutput.append(error)
            throw LaunchctlError(
                arguments: arguments,
                status: process.terminationStatus,
                output: String(decoding: combinedOutput, as: UTF8.self)
            )
        }
    }
}

struct LaunchctlError: Error, Equatable {
    let arguments: [String]
    let status: Int32
    let output: String
}
