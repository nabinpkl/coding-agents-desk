import Foundation
import os
import AgentDeskWire

@MainActor
final class HostTextInputFocusProbeCoordinator {
    typealias CursorKindSampler = @Sendable () -> CursorKind?

    private let resolver: HostTextInputFocusResolver
    private let cursorKindSampler: CursorKindSampler
    private let initialDelayNs: UInt64
    private let settleDelayNs: UInt64
    private let logger: Logger
    private var tasks: [DeviceFingerprint: ProbeTask] = [:]

    private struct ProbeTask {
        let id: UUID
        let task: Task<Void, Never>
    }

    init(
        resolver: HostTextInputFocusResolver = HostTextInputFocusResolver(),
        cursorKindSampler: @escaping CursorKindSampler = { CursorMonitor.systemSampler()?.cursorKind },
        initialDelayNs: UInt64 = 80_000_000,
        settleDelayNs: UInt64 = 160_000_000,
        logger: Logger = Logger(subsystem: Config.logSubsystem, category: "signaling")
    ) {
        self.resolver = resolver
        self.cursorKindSampler = cursorKindSampler
        self.initialDelayNs = initialDelayNs
        self.settleDelayNs = settleDelayNs
        self.logger = logger
    }

    func schedule(for fingerprint: DeviceFingerprint, server: InputChannelServing) {
        tasks[fingerprint]?.task.cancel()
        let id = UUID()
        let task = Task<Void, Never> { @MainActor [weak self, weak server] in
            guard let self else { return }
            await self.resolveAfterClick(id: id, for: fingerprint, server: server)
        }
        tasks[fingerprint] = ProbeTask(id: id, task: task)
    }

    func cancel(for fingerprint: DeviceFingerprint) {
        tasks[fingerprint]?.task.cancel()
        tasks[fingerprint] = nil
    }

    func cancelAll() {
        for probe in tasks.values {
            probe.task.cancel()
        }
        tasks.removeAll()
    }

    private func resolveAfterClick(
        id: UUID,
        for fingerprint: DeviceFingerprint,
        server: InputChannelServing?
    ) async {
        defer {
            if tasks[fingerprint]?.id == id {
                tasks[fingerprint] = nil
            }
        }
        await sleep(initialDelayNs)
        guard !Task.isCancelled, let server else { return }
        let cursorKind = cursorKindSampler() ?? .unknown
        guard cursorKind == .ibeam else {
            server.pushTextInputFocus(HostTextInputFocusPush(
                editability: .nonEditable,
                secure: false,
                source: .none,
                cursorKind: cursorKind
            ))
            return
        }

        logger.notice("textFocusProbeStarted cursorKind=\(cursorKind.rawValue, privacy: .public)")
        var focus = resolver.sampleCurrentFocus(cursorKind: cursorKind)
        if focus.editability == .nonEditable {
            await sleep(settleDelayNs)
            guard !Task.isCancelled else { return }
            let settledCursorKind = cursorKindSampler() ?? cursorKind
            focus = resolver.sampleCurrentFocus(cursorKind: settledCursorKind)
        }
        let resolved = annotateFallbackSource(focus)
        logger.notice("textFocusProbeResolved editability=\(resolved.editability.rawValue, privacy: .public) source=\(resolved.source.rawValue, privacy: .public) role=\(resolved.role ?? "nil", privacy: .public) subrole=\(resolved.subrole ?? "nil", privacy: .public) cursorKind=\(resolved.cursorKind?.rawValue ?? "nil", privacy: .public)")
        server.pushTextInputFocus(resolved)
    }

    private func sleep(_ nanoseconds: UInt64) async {
        guard nanoseconds > 0 else { return }
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    private func annotateFallbackSource(_ focus: HostTextInputFocusPush) -> HostTextInputFocusPush {
        guard focus.editability == .ambiguous, focus.cursorKind == .ibeam else {
            return focus
        }
        return HostTextInputFocusPush(
            editability: focus.editability,
            secure: focus.secure,
            source: .cursorTapHeuristic,
            role: focus.role,
            subrole: focus.subrole,
            cursorKind: focus.cursorKind
        )
    }
}
