import AgentDeskWire
import BrowserProjection
import Foundation
import os

@MainActor
final class BrowserProjectionViewportCoordinator {
    enum ViewerID: Hashable, Sendable {
        case local
        case remote(DeviceFingerprint)
    }

    private struct Viewer: Equatable {
        var command: BrowserProjectionViewerStateCommand
        var activation: UInt64
    }

    private struct ResolvedSource: Equatable {
        let active: Bool
        let profile: BrowserProjectionViewportProfile?
        let sizing: BrowserProjectionViewportSizing?
        let width: Int?
        let height: Int?
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "browser-viewport")
    private let hostEpoch = UUID().uuidString
    private let sendToBridge: (Data) -> Bool
    var onViewerStatus: ((ViewerID, Data) -> Void)?

    private var viewers: [ViewerID: Viewer] = [:]
    private var activationClock: UInt64 = 0
    private var revision = 0
    private var targetTabId: Int?
    private var generation = 0
    private var bridgeConnected = false
    private var lastSource: ResolvedSource?
    private var sourceRetryNeeded = false

    init(sendToBridge: @escaping (Data) -> Bool) {
        self.sendToBridge = sendToBridge
    }

    func register(_ id: ViewerID, profile: BrowserProjectionViewportProfile) {
        guard viewers[id] == nil else {
            applyResolvedSourceIfNeeded(force: true)
            publishStatuses()
            return
        }
        viewers[id] = Viewer(
            command: BrowserProjectionViewerStateCommand(
                active: false,
                claim: false,
                profile: profile,
                sizing: .viewer,
                width: 1,
                height: 1
            ),
            activation: 0
        )
        publishStatuses()
    }

    func remove(_ id: ViewerID) {
        guard viewers.removeValue(forKey: id) != nil else { return }
        applyResolvedSourceIfNeeded()
        publishStatuses()
    }

    func update(_ command: BrowserProjectionViewerStateCommand, from id: ViewerID) {
        do {
            try command.validate()
        } catch {
            logger.warning("rejected invalid viewer viewport command")
            return
        }
        let normalized = Self.normalized(command)
        var viewer = viewers[id] ?? Viewer(command: normalized, activation: 0)
        viewer.command = normalized
        if normalized.active && normalized.claim {
            activationClock &+= 1
            viewer.activation = activationClock
        }
        viewers[id] = viewer
        let retry = sourceRetryNeeded && normalized.active && normalized.claim && ownerID == id
        if retry { sourceRetryNeeded = false }
        applyResolvedSourceIfNeeded(force: retry)
        publishStatuses()
    }

    func updateAppliedViewport(_ viewport: BrowserProjectionViewportState?) {
        sourceRetryNeeded = viewport?.error != nil
    }

    func updateTarget(tabId: Int?, generation: Int) {
        let changed = targetTabId != tabId || self.generation != generation
        targetTabId = tabId
        self.generation = generation
        if changed, bridgeConnected { applyResolvedSourceIfNeeded(force: true) }
    }

    func setBridgeConnected(_ connected: Bool) {
        bridgeConnected = connected
        if connected { applyResolvedSourceIfNeeded(force: true) }
    }

    func status(for id: ViewerID) -> BrowserProjectionViewerStatus? {
        guard let viewer = viewers[id] else { return nil }
        return BrowserProjectionViewerStatus(
            owner: ownerID == id,
            active: viewer.command.active,
            profile: viewer.command.profile,
            sizing: viewer.command.sizing,
            width: viewer.command.width,
            height: viewer.command.height
        )
    }

    private var ownerID: ViewerID? {
        viewers
            .filter { $0.value.command.active }
            .max { lhs, rhs in lhs.value.activation < rhs.value.activation }?
            .key
    }

    private func applyResolvedSourceIfNeeded(force: Bool = false) {
        let source = resolvedSource()
        guard force || source != lastSource else { return }
        lastSource = source
        revision += 1
        guard bridgeConnected else { return }
        let command = BrowserProjectionSourceViewportCommand(
            hostEpoch: hostEpoch,
            revision: revision,
            active: source.active,
            tabId: targetTabId,
            generation: generation,
            profile: source.profile,
            sizing: source.sizing,
            width: source.width,
            height: source.height
        )
        do {
            try command.validate()
            if !sendToBridge(try JSONEncoder().encode(command)) {
                logger.debug("source viewport dropped because bridge is disconnected")
            }
        } catch {
            logger.error("source viewport encoding failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func resolvedSource() -> ResolvedSource {
        guard let ownerID, let command = viewers[ownerID]?.command else {
            return ResolvedSource(active: false, profile: nil, sizing: nil, width: nil, height: nil)
        }
        return ResolvedSource(
            active: true,
            profile: command.profile,
            sizing: command.sizing,
            width: command.width,
            height: command.height
        )
    }

    private func publishStatuses() {
        guard let onViewerStatus else { return }
        for id in viewers.keys {
            guard let status = status(for: id), let payload = try? JSONEncoder().encode(status) else { continue }
            onViewerStatus(id, payload)
        }
    }

    private static func normalized(
        _ command: BrowserProjectionViewerStateCommand
    ) -> BrowserProjectionViewerStateCommand {
        guard command.sizing == .preset else { return command }
        let size = command.profile == .desktop ? (1_440, 900) : (390, 844)
        return BrowserProjectionViewerStateCommand(
            active: command.active,
            claim: command.claim,
            profile: command.profile,
            sizing: .preset,
            width: size.0,
            height: size.1
        )
    }
}
