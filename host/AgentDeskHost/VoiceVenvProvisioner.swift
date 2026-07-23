import Foundation
import os

// VoiceVenvProvisioner builds the Python virtual environment the voice sidecar
// runs from, in a writable per-user location (Application Support). The shipped
// app cannot run Python out of its read-only, code-signed bundle, so on first
// launch (or when the staged source version changes) it creates the venv with
// the bundled `uv` and installs the bundled interaction-agent source — core
// deps only, no `desktop` extra. Offline when a wheelhouse is bundled.
//
// This mirrors, exactly, the chain proven on the command line:
//   uv venv <venv> --python 3.13
//   uv pip install --python <venv>/bin/python <source> [--find-links <wheels> --offline]
// after which <venv>/bin/voice-server is the console entry the sidecar spawns.
//
// It is idempotent: a stamp file records the provisioned source version, so a
// matching stamp short-circuits with no work.
final class VoiceVenvProvisioner: @unchecked Sendable {
    struct Inputs {
        /// The bundled `uv` executable.
        let uvURL: URL
        /// The bundled source directory (holds pyproject.toml + src/).
        let sourceURL: URL
        /// Target venv directory in Application Support (writable).
        let venvURL: URL
        /// uv's cache directory (writable; kept out of the sandbox's default).
        let cacheURL: URL
        /// Optional bundled offline wheelhouse; when present, install runs offline.
        let wheelhouseURL: URL?
        /// Opaque version of the staged source; a changed value forces a rebuild.
        let versionStamp: String
    }

    enum ProvisionError: Error {
        case commandFailed(command: String, status: Int32, output: String)
    }

    private let inputs: Inputs
    private let logger: Logger
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).voice-venv-provisioner")

    init(inputs: Inputs) {
        self.inputs = inputs
        self.logger = Logger(subsystem: Config.logSubsystem, category: "voice-venv-provisioner")
    }

    /// The console entry the sidecar spawns once provisioning succeeds.
    var voiceServerExecutable: URL {
        inputs.venvURL.appendingPathComponent("bin/voice-server")
    }

    private var stampURL: URL {
        inputs.venvURL.appendingPathComponent(".provision-stamp")
    }

    /// True when the venv already exists and matches the staged source version,
    /// so the sidecar can start immediately without waiting for provisioning.
    var isUpToDate: Bool {
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: voiceServerExecutable.path) else { return false }
        guard let stamp = try? String(contentsOf: stampURL, encoding: .utf8) else { return false }
        return stamp == inputs.versionStamp
    }

    /// Ensure the venv is present and current. Completion runs on an arbitrary
    /// queue; the caller hops to the main actor as needed. Fails loud: on error
    /// the venv is left as-is and the error is reported (no partial success).
    func ensureProvisioned(_ completion: @escaping (Result<URL, Error>) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.isUpToDate {
                completion(.success(self.voiceServerExecutable))
                return
            }
            do {
                try self.provision()
                completion(.success(self.voiceServerExecutable))
            } catch {
                self.logger.error("voice venv provisioning failed: \(String(describing: error), privacy: .public)")
                completion(.failure(error))
            }
        }
    }

    // MARK: - Private

    private func provision() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: inputs.cacheURL, withIntermediateDirectories: true)
        // A stale venv is removed wholesale so a failed prior run never leaves a
        // half-populated environment the sidecar would spawn against.
        if fm.fileExists(atPath: inputs.venvURL.path) {
            try? fm.removeItem(at: inputs.venvURL)
        }
        try fm.createDirectory(
            at: inputs.venvURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        logger.notice("voice venv: creating at \(self.inputs.venvURL.path, privacy: .public)")
        try run(arguments: ["venv", inputs.venvURL.path, "--python", "3.13"])

        let venvPython = inputs.venvURL.appendingPathComponent("bin/python").path
        var install = ["pip", "install", "--python", venvPython, inputs.sourceURL.path]
        if let wheelhouse = inputs.wheelhouseURL,
            fm.fileExists(atPath: wheelhouse.path) {
            // Offline install from the bundled wheelhouse — no PyPI reachability
            // required on first launch.
            install += ["--find-links", wheelhouse.path, "--offline"]
        }
        logger.notice("voice venv: installing interaction-agent (core)")
        try run(arguments: install)

        try inputs.versionStamp.write(to: stampURL, atomically: true, encoding: .utf8)
        logger.notice("voice venv: provisioned stamp=\(self.inputs.versionStamp, privacy: .public)")
    }

    /// Run the bundled `uv` with the given arguments; throw with captured output
    /// on any non-zero exit.
    private func run(arguments: [String]) throws {
        let proc = Process()
        proc.executableURL = inputs.uvURL
        proc.arguments = arguments
        proc.currentDirectoryURL = inputs.sourceURL
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "UV_CACHE_DIR": inputs.cacheURL.path,
            // Never let uv try to manage a system-wide or in-source project env.
            "UV_NO_CONFIG": "1",
        ]) { _, new in new }

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        try proc.run()
        // Read before waitUntilExit so a large output never deadlocks the pipe.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        if proc.terminationStatus != 0 {
            let output = String(data: data, encoding: .utf8) ?? ""
            throw ProvisionError.commandFailed(
                command: "uv \(arguments.joined(separator: " "))",
                status: proc.terminationStatus,
                output: String(output.suffix(2000))
            )
        }
    }
}
