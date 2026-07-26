import Foundation
import Testing

@testable import AgentDeskHost

// Tests for VoiceVenvProvisioner's ownership contract, using a stub `uv` shell
// script so no real venv is built and `just check` stays hermetic. The stub
// mimics the one behavior the provisioner depends on — `uv venv <path>` creates
// the directory and its bin/voice-server console entry — and records every
// invocation so a test can assert which commands ran. The real uv chain is
// exercised by launching the host.
struct VoiceVenvProvisionerTests {

    private func makeInputs(root: URL, versionStamp: String = "1.0.0") throws -> VoiceVenvProvisioner.Inputs {
        let source = root.appendingPathComponent("voice-src", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        return VoiceVenvProvisioner.Inputs(
            uvURL: try makeStubUv(root: root),
            sourceURL: source,
            venvURL: root.appendingPathComponent("voice-venv", isDirectory: true),
            cacheURL: root.appendingPathComponent("voice-uv-cache", isDirectory: true),
            wheelhouseURL: nil,
            versionStamp: versionStamp
        )
    }

    /// Path the stub appends one line per invocation to.
    private func invocationLog(root: URL) -> URL {
        root.appendingPathComponent("uv-invocations.txt")
    }

    private func makeStubUv(root: URL) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = """
            #!/bin/sh
            echo "$@" >> "\(invocationLog(root: root).path)"
            if [ "$1" = "venv" ]; then
              mkdir -p "$2/bin"
              : > "$2/bin/voice-server"
              chmod +x "$2/bin/voice-server"
            fi
            exit 0
            """
        let url = root.appendingPathComponent("uv")
        try script.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    // The caller (AppDelegate.startVoiceEngineSidecar) builds a provisioner,
    // calls ensureProvisioned, and immediately drops its reference. Provisioning
    // must still run to completion. A weak self-capture in the queued work made
    // this a silent no-op: no venv, no log line, and the voice sidecar never
    // started, so the webview's ws://127.0.0.1:<port>/ws/voice connect failed.
    @Test func provisioningCompletesAfterCallerDropsItsReference() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-provisioner-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let inputs = try makeInputs(root: root)

        let finished = DispatchSemaphore(value: 0)
        let outcome = Locked<Result<URL, Error>?>(nil)
        // Scoped so the only strong reference is gone before the queue drains.
        do {
            let provisioner = VoiceVenvProvisioner(inputs: inputs)
            provisioner.ensureProvisioned { result in
                outcome.value = result
                finished.signal()
            }
        }

        #expect(finished.wait(timeout: .now() + 10) == .success)
        guard case .success(let executable)? = outcome.value else {
            Issue.record("provisioning did not report success: \(String(describing: outcome.value))")
            return
        }
        #expect(executable.path.hasSuffix("voice-venv/bin/voice-server"))
        // The stamp is the provisioner's own record that it ran to the end.
        let stamp = try String(
            contentsOf: inputs.venvURL.appendingPathComponent(".provision-stamp"),
            encoding: .utf8
        )
        #expect(stamp == inputs.versionStamp)
        // Both uv commands actually ran, in order.
        let invocations = try String(contentsOf: invocationLog(root: root), encoding: .utf8)
            .split(separator: "\n")
        #expect(invocations.count == 2)
        #expect(invocations.first?.hasPrefix("venv ") == true)
        #expect(invocations.last?.hasPrefix("pip install ") == true)
    }

    // The venv holds a copy of the staged source, so a changed stamp is the only
    // thing that makes an edit reach the running sidecar. Config derives the
    // stamp from the staged content hash for exactly this reason.
    @Test func changedStampRebuildsTheVenv() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-provisioner-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try makeInputs(root: root, versionStamp: "hash-aaa")

        try provisionAndWait(inputs: first)
        #expect(try stampContents(of: first) == "hash-aaa")

        let second = VoiceVenvProvisioner.Inputs(
            uvURL: first.uvURL,
            sourceURL: first.sourceURL,
            venvURL: first.venvURL,
            cacheURL: first.cacheURL,
            wheelhouseURL: first.wheelhouseURL,
            versionStamp: "hash-bbb"
        )
        try provisionAndWait(inputs: second)
        #expect(try stampContents(of: second) == "hash-bbb")

        // Four invocations: venv + pip install, twice.
        let invocations = try String(contentsOf: invocationLog(root: root), encoding: .utf8)
            .split(separator: "\n")
        #expect(invocations.count == 4)
    }

    private func provisionAndWait(inputs: VoiceVenvProvisioner.Inputs) throws {
        let finished = DispatchSemaphore(value: 0)
        let outcome = Locked<Result<URL, Error>?>(nil)
        VoiceVenvProvisioner(inputs: inputs).ensureProvisioned { result in
            outcome.value = result
            finished.signal()
        }
        #expect(finished.wait(timeout: .now() + 10) == .success)
        if case .success = outcome.value {} else {
            Issue.record("provisioning failed: \(String(describing: outcome.value))")
        }
    }

    private func stampContents(of inputs: VoiceVenvProvisioner.Inputs) throws -> String {
        try String(
            contentsOf: inputs.venvURL.appendingPathComponent(".provision-stamp"),
            encoding: .utf8
        )
    }

    // A matching stamp short-circuits with no uv invocation. Guarding the fast
    // path keeps repeat launches from rebuilding a good venv.
    @Test func upToDateVenvSkipsProvisioning() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-provisioner-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let inputs = try makeInputs(root: root)

        let bin = inputs.venvURL.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: bin.appendingPathComponent("voice-server").path,
            contents: Data(),
            attributes: [.posixPermissions: 0o755]
        )
        try inputs.versionStamp.write(
            to: inputs.venvURL.appendingPathComponent(".provision-stamp"),
            atomically: true,
            encoding: .utf8
        )

        let finished = DispatchSemaphore(value: 0)
        let outcome = Locked<Result<URL, Error>?>(nil)
        VoiceVenvProvisioner(inputs: inputs).ensureProvisioned { result in
            outcome.value = result
            finished.signal()
        }

        #expect(finished.wait(timeout: .now() + 10) == .success)
        if case .success = outcome.value {} else {
            Issue.record("up-to-date venv did not report success: \(String(describing: outcome.value))")
        }
        // The stub writes its log on every call, so an absent log proves uv was
        // never invoked and the existing venv was left alone.
        #expect(!FileManager.default.fileExists(atPath: invocationLog(root: root).path))
    }
}

// Minimal mutable box for a value written on the provisioner's queue and read
// after the semaphore, which establishes the ordering.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) { storage = value }

    var value: Value {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}
