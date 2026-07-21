import AgentDeskWire
import BrowserProjection
import Foundation
import os

@MainActor
final class BrowserProjectionSession {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "browser-projection")
    private let sendToBridge: (Data) -> Bool
    private let viewportCoordinator: BrowserProjectionViewportCoordinator
    private let hostSHA: String
    private weak var controller: BrowserProjectionWindowController?
    private var browserState: BrowserProjectionState?
    private var browserStatePayload: Data?
    private var isBridgeConnected = false

    init(
        hostSHA: String,
        viewportCoordinator: BrowserProjectionViewportCoordinator,
        sendToBridge: @escaping (Data) -> Bool
    ) {
        self.hostSHA = hostSHA
        self.viewportCoordinator = viewportCoordinator
        self.sendToBridge = sendToBridge
    }

    convenience init(hostSHA: String, sendToBridge: @escaping (Data) -> Bool) {
        self.init(
            hostSHA: hostSHA,
            viewportCoordinator: BrowserProjectionViewportCoordinator(sendToBridge: sendToBridge),
            sendToBridge: sendToBridge
        )
    }

    func attach(_ controller: BrowserProjectionWindowController) {
        self.controller = controller
        controller.bindIntents(
            onSelectWindow: { [weak self] windowId, generation in
                self?.selectWindow(windowId, generation: generation)
            },
            onSelectTab: { [weak self] windowId, tabId, generation in
                self?.selectTab(windowId, tabId: tabId, generation: generation)
            },
            onTap: { [weak self] x, y in self?.tap(x: x, y: y) },
            onScroll: { [weak self] x, y, dx, dy in
                self?.scroll(x: x, y: y, dx: dx, dy: dy)
            },
            onViewerState: { [weak self] command in
                self?.viewportCoordinator.update(command, from: .local)
            }
        )
        deliverHostState()
        if let browserStatePayload { controller.receive(browserStatePayload) }
        if let status = viewportCoordinator.status(for: .local),
           let payload = try? JSONEncoder().encode(status) {
            controller.receive(payload)
        }
        requestState()
    }

    func receiveBrowserState(_ payload: Data, state: BrowserProjectionState) {
        if let browserState {
            guard state.generation >= browserState.generation else {
                logger.debug("dropping stale browser state generation=\(state.generation)")
                return
            }
            if state.generation == browserState.generation {
                let oldTarget = target(in: browserState)
                let newTarget = target(in: state)
                guard oldTarget.windowId == newTarget.windowId,
                      oldTarget.tabId == newTarget.tabId else {
                    logger.warning("dropping browser state that changes target without advancing generation")
                    return
                }
            }
        }
        browserState = state
        browserStatePayload = payload
        controller?.receive(payload)
        viewportCoordinator.updateAppliedViewport(state.viewport)
        viewportCoordinator.updateTarget(tabId: target(in: state).tabId, generation: state.generation)
    }

    func receiveBatch(_ payload: Data) {
        guard let browserState else {
            logger.debug("dropping browser batch before state")
            return
        }
        guard let header = try? JSONDecoder().decode(BrowserProjectionBatchHeader.self, from: payload),
              header.type == "dom-batch" else {
            logger.warning("dropping malformed browser batch header")
            return
        }
        guard header.generation == browserState.generation,
              let window = browserState.windows.first(where: { $0.id == browserState.projectedWindowId }),
              header.tabId == window.activeTabId else {
            logger.debug("dropping stale browser batch tab=\(header.tabId) generation=\(header.generation)")
            return
        }
        controller?.receive(payload)
    }

    func setBridgeConnected(_ connected: Bool) {
        isBridgeConnected = connected
        viewportCoordinator.setBridgeConnected(connected)
        deliverHostState()
        if connected { requestState() }
    }

    func receiveViewerStatus(_ payload: Data) {
        controller?.receive(payload)
    }

    func selectWindow(_ windowId: Int, generation: Int) {
        guard let browserState,
              generation == browserState.generation,
              browserState.windows.contains(where: { $0.id == windowId }) else { return }
        send(BrowserProjectionSelectWindowCommand(windowId: windowId, generation: generation))
    }

    func selectTab(_ windowId: Int, tabId: Int, generation: Int) {
        guard let browserState,
              generation == browserState.generation,
              browserState.projectedWindowId == windowId,
              let window = browserState.windows.first(where: { $0.id == windowId }),
              window.tabs.contains(where: { $0.id == tabId }) else { return }
        send(BrowserProjectionSelectTabCommand(
            windowId: windowId,
            tabId: tabId,
            generation: generation
        ))
    }

    func tap(x: Double, y: Double) {
        guard hasInteractivePage else { return }
        send(DomInputCommand(x: x, y: y))
    }

    func scroll(x: Double, y: Double, dx: Double, dy: Double) {
        guard hasInteractivePage else { return }
        send(DomScrollCommand(x: x, y: y, dx: dx, dy: dy))
    }

    func requestState() {
        guard isBridgeConnected else { return }
        sendRaw(["t": "browser-state-request"])
    }

    private var hasInteractivePage: Bool {
        guard let browserState,
              let window = browserState.windows.first(where: { $0.id == browserState.projectedWindowId }),
              let tab = window.tabs.first(where: { $0.id == window.activeTabId }) else { return false }
        return !tab.restricted && !tab.discarded && tab.status == "complete"
    }

    private func target(in state: BrowserProjectionState) -> (windowId: Int?, tabId: Int?) {
        guard let window = state.windows.first(where: { $0.id == state.projectedWindowId }) else {
            return (nil, nil)
        }
        return (window.id, window.activeTabId)
    }

    private func deliverHostState() {
        do {
            controller?.receive(try JSONEncoder().encode(BrowserProjectionHostState(
                connected: isBridgeConnected,
                sha: hostSHA
            )))
        } catch {
            logger.error("browser host-state encoding failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func send<T: Encodable>(_ command: T) {
        do {
            if !sendToBridge(try JSONEncoder().encode(command)) {
                logger.debug("browser command dropped because the bridge is disconnected")
            }
        } catch {
            logger.error("browser command encoding failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func sendRaw(_ object: [String: String]) {
        do {
            if !sendToBridge(try JSONSerialization.data(withJSONObject: object)) {
                logger.debug("browser state request dropped because the bridge is disconnected")
            }
        } catch {
            logger.error("browser state request encoding failed: \(String(describing: error), privacy: .public)")
        }
    }
}

final class BrowserProjectionLocalLane: @unchecked Sendable {
    enum Message {
        case browserState(Data, BrowserProjectionState)
        case batch(Data)
        case bridgeConnected(Bool)
    }

    private struct State {
        var session: BrowserProjectionSession?
        var pending: [Message] = []
        var nextIndex = 0
        var isDraining = false
    }

    private let lock: OSAllocatedUnfairLock<State>

    init(session: BrowserProjectionSession) {
        lock = OSAllocatedUnfairLock(initialState: State(session: session))
    }

    func send(_ message: Message) {
        let shouldDrain = lock.withLock { state in
            guard state.session != nil else { return false }
            state.pending.append(message)
            guard !state.isDraining else { return false }
            state.isDraining = true
            return true
        }
        guard shouldDrain else { return }
        Task { @MainActor [weak self] in self?.drain() }
    }

    func close() {
        lock.withLock { state in
            state.session = nil
            state.pending = []
            state.nextIndex = 0
            state.isDraining = false
        }
    }

    @MainActor
    private func drain() {
        while let next = lock.withLock({ state -> (BrowserProjectionSession, Message)? in
            guard let session = state.session, state.nextIndex < state.pending.count else {
                state.pending = []
                state.nextIndex = 0
                state.isDraining = false
                return nil
            }
            let message = state.pending[state.nextIndex]
            state.nextIndex += 1
            return (session, message)
        }) {
            switch next.1 {
            case .browserState(let payload, let state):
                next.0.receiveBrowserState(payload, state: state)
            case .batch(let payload):
                next.0.receiveBatch(payload)
            case .bridgeConnected(let connected):
                next.0.setBridgeConnected(connected)
            }
        }
    }
}
