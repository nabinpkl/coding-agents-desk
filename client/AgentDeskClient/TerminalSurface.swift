import Foundation
import os
import PtyClientSwift
import UIKit

@available(iOS 26.0, *)
final class TerminalSurface: UIView, @MainActor TerminalPaneViewDelegate, TerminalSessionDrawerViewDelegate {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal-surface")
    private let workspaceContainer = UIView()
    private let sessionDrawerButton = UIButton(type: .system)
    private let sessionDrawerView = TerminalSessionDrawerView()
    private var transport: QuicSessionClientTransport?
    private var workspaceState = TerminalWorkspaceState()
    private var paneViews: [TerminalPaneID: TerminalPaneView] = [:]
    private var closingPaneIDs = Set<TerminalPaneID>()
    private var renderedRootView: UIView?
    private var sessionSnapshotTask: Task<Void, Never>?
    private var isViewportPresented = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        configureView()
        syncPaneViewsWithState()
        renderWorkspace()
        applyFocus()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    deinit {
        sessionSnapshotTask?.cancel()
        Task { @MainActor [paneViews] in
            for paneView in paneViews.values {
                paneView.detach()
            }
        }
    }

    func connect(using transport: QuicSessionClientTransport?) {
        if self.transport !== transport {
            for paneView in paneViews.values {
                paneView.detach()
            }
            stopSessionSnapshotMonitoring()
        }
        self.transport = transport
        if let transport, sessionSnapshotTask == nil {
            startSessionSnapshotMonitoring(using: transport)
        } else if transport == nil {
            sessionDrawerView.setSessions([], status: "Terminal transport is disconnected.")
        }
        for leaf in workspaceState.allLeaves() {
            paneViews[leaf.paneID]?.connect(using: transport)
        }
    }

    func detach() {
        for paneView in paneViews.values {
            paneView.detach()
        }
        transport = nil
        stopSessionSnapshotMonitoring()
        sessionDrawerView.setSessions([], status: "Terminal transport is disconnected.")
    }

    func setViewportPresented(_ presented: Bool) {
        guard isViewportPresented != presented else { return }
        isViewportPresented = presented
        applyFocus()
    }

    func flushViewportResize() {
        guard let focused = paneViews[workspaceState.focusedPaneID] else { return }
        focused.flushViewportResize()
    }

    #if DEBUG
    func debugSplitFocusedPaneForTesting(axis: TerminalSplitAxis) {
        guard let newLeaf = workspaceState.splitPane(workspaceState.focusedPaneID, axis: axis) else {
            return
        }
        paneViews[newLeaf.paneID] = makePaneView(for: newLeaf)
        renderWorkspace()
        applyFocus()
    }

    func debugWorkspaceLeafCountForTesting() -> Int {
        workspaceState.leafCount
    }

    func debugPaneViewIDsForTesting() -> Set<TerminalPaneID> {
        Set(paneViews.keys)
    }
    #endif

    func terminalPaneViewRequestedFocus(_ paneView: TerminalPaneView) {
        guard workspaceState.focusPane(paneView.leaf.paneID) else { return }
        applyFocus()
    }

    func terminalPaneView(_ paneView: TerminalPaneView, requestedSplit axis: TerminalSplitAxis) {
        guard let newLeaf = workspaceState.splitPane(paneView.leaf.paneID, axis: axis) else { return }
        let newPaneView = makePaneView(for: newLeaf)
        paneViews[newLeaf.paneID] = newPaneView
        newPaneView.connect(using: transport)
        renderWorkspace()
        applyFocus()
    }

    func terminalPaneViewRequestedClose(_ paneView: TerminalPaneView) {
        let paneID = paneView.leaf.paneID
        guard closingPaneIDs.insert(paneID).inserted else { return }
        paneView.setCloseEnabled(false)

        Task { @MainActor [weak self, weak paneView] in
            guard let self, let paneView else { return }
            let closeResult = await paneView.closeForUser()
            guard self.closingPaneIDs.contains(paneID) else { return }
            switch closeResult {
            case .detached, .killed, .closedBeforeAttach:
                self.removeClosedPane(paneID)
            case .failed:
                self.closingPaneIDs.remove(paneID)
                self.applyFocus()
            }
        }
    }

    func terminalSessionDrawerViewRequestedDismiss(_ drawerView: TerminalSessionDrawerView) {
        drawerView.setVisible(false)
    }

    func terminalSessionDrawerView(_ drawerView: TerminalSessionDrawerView, requestedJoin session: PtySessionSummary) {
        guard session.state == .running else {
            drawerView.setStatus("Session \(session.name) is not running.")
            return
        }
        guard let newLeaf = workspaceState.openExistingSession(session.name) else {
            drawerView.setStatus("Could not open \(session.name).")
            return
        }
        let newPaneView = makePaneView(for: newLeaf)
        paneViews[newLeaf.paneID] = newPaneView
        newPaneView.connect(using: transport)
        renderWorkspace()
        applyFocus()
        drawerView.setVisible(false)
    }

    func terminalSessionDrawerView(_ drawerView: TerminalSessionDrawerView, requestedCloseSession session: PtySessionSummary) {
        runSessionCommand(status: "Closing \(session.name)...") { client in
            try await client.killSession(name: session.name)
        } onSuccess: { [weak self] in
            self?.removeLocalPanes(sessionName: session.name)
            drawerView.setStatus("Closed \(session.name).")
        }
    }

    func terminalSessionDrawerView(
        _ drawerView: TerminalSessionDrawerView,
        requestedCloseClient client: PtySessionClientSummary,
        in sessionName: String
    ) {
        let localPaneID = localPaneID(sessionName: sessionName, clientID: client.id)
        runSessionCommand(status: "Closing client \(client.id)...") { ptyClient in
            try await ptyClient.closeClient(sessionName: sessionName, clientID: client.id)
        } onSuccess: { [weak self] in
            if let localPaneID {
                self?.removeLocalPane(localPaneID)
            }
            drawerView.setStatus("Closed client \(client.id).")
        }
    }

    private func configureView() {
        backgroundColor = .black
        workspaceContainer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(workspaceContainer)

        sessionDrawerButton.translatesAutoresizingMaskIntoConstraints = false
        sessionDrawerButton.setImage(UIImage(systemName: "list.bullet.rectangle"), for: .normal)
        sessionDrawerButton.tintColor = .white
        sessionDrawerButton.backgroundColor = UIColor.black.withAlphaComponent(0.58)
        sessionDrawerButton.layer.cornerRadius = 8
        sessionDrawerButton.accessibilityLabel = "Show PTY sessions"
        sessionDrawerButton.addTarget(self, action: #selector(handleSessionDrawerButton), for: .touchUpInside)
        addSubview(sessionDrawerButton)

        sessionDrawerView.translatesAutoresizingMaskIntoConstraints = false
        sessionDrawerView.delegate = self
        addSubview(sessionDrawerView)

        NSLayoutConstraint.activate([
            workspaceContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            workspaceContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            workspaceContainer.topAnchor.constraint(equalTo: topAnchor),
            workspaceContainer.bottomAnchor.constraint(equalTo: bottomAnchor),

            sessionDrawerButton.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -12),
            sessionDrawerButton.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 12),
            sessionDrawerButton.widthAnchor.constraint(equalToConstant: 44),
            sessionDrawerButton.heightAnchor.constraint(equalToConstant: 36),

            sessionDrawerView.leadingAnchor.constraint(equalTo: leadingAnchor),
            sessionDrawerView.trailingAnchor.constraint(equalTo: trailingAnchor),
            sessionDrawerView.topAnchor.constraint(equalTo: topAnchor),
            sessionDrawerView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    private func syncPaneViewsWithState() {
        for leaf in workspaceState.allLeaves() where paneViews[leaf.paneID] == nil {
            paneViews[leaf.paneID] = makePaneView(for: leaf)
        }
    }

    private func makePaneView(for leaf: TerminalPaneLeaf) -> TerminalPaneView {
        let paneView = TerminalPaneView(leaf: leaf)
        paneView.delegate = self
        return paneView
    }

    private func renderWorkspace() {
        syncPaneViewsWithState()
        renderedRootView?.removeFromSuperview()
        let rootView = buildView(for: workspaceState.root)
        rootView.translatesAutoresizingMaskIntoConstraints = false
        workspaceContainer.addSubview(rootView)
        NSLayoutConstraint.activate([
            rootView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
            rootView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
            rootView.topAnchor.constraint(equalTo: workspaceContainer.topAnchor),
            rootView.bottomAnchor.constraint(equalTo: workspaceContainer.bottomAnchor)
        ])
        renderedRootView = rootView
        logger.debug("terminal workspace rendered panes=\(self.workspaceState.leafCount, privacy: .public)")
    }

    private func buildView(for node: TerminalPaneNode) -> UIView {
        switch node {
        case .leaf(let leaf):
            guard let paneView = paneViews[leaf.paneID] else {
                let placeholder = UIView()
                placeholder.backgroundColor = .black
                return placeholder
            }
            return paneView
        case .split(let split):
            let stack = UIStackView(arrangedSubviews: [
                buildView(for: split.first),
                buildView(for: split.second)
            ])
            stack.translatesAutoresizingMaskIntoConstraints = false
            stack.axis = split.axis == .horizontal ? .horizontal : .vertical
            stack.spacing = 8
            stack.distribution = .fillEqually
            return stack
        }
    }

    private func applyFocus() {
        for leaf in workspaceState.allLeaves() {
            let paneView = paneViews[leaf.paneID]
            paneView?.setFocused(
                isViewportPresented && leaf.paneID == workspaceState.focusedPaneID
            )
            paneView?.setCloseEnabled(!closingPaneIDs.contains(leaf.paneID))
        }
    }

    private func removeClosedPane(_ paneID: TerminalPaneID) {
        guard let closeResult = workspaceState.closePane(paneID) else {
            closingPaneIDs.remove(paneID)
            applyFocus()
            return
        }

        switch closeResult {
        case .removed(let removedLeaf):
            paneViews[removedLeaf.paneID] = nil
            closingPaneIDs.remove(removedLeaf.paneID)
        case .reset(let removedLeaf, let replacementLeaf):
            paneViews[removedLeaf.paneID] = nil
            closingPaneIDs.remove(removedLeaf.paneID)
            let replacementPaneView = makePaneView(for: replacementLeaf)
            paneViews[replacementLeaf.paneID] = replacementPaneView
            replacementPaneView.connect(using: transport)
        }

        renderWorkspace()
        applyFocus()
    }

    private func startSessionSnapshotMonitoring(using transport: QuicSessionClientTransport) {
        sessionSnapshotTask?.cancel()
        sessionDrawerView.setStatus("Loading PTY sessions...")
        sessionSnapshotTask = Task { [weak self, weak transport] in
            while !Task.isCancelled {
                do {
                    guard let transport else { throw PtyClientError.closed }
                    let client = try await transport.openTerminalPtyClient()
                    for try await sessions in client.sessionSnapshots() {
                        try Task.checkCancellation()
                        await MainActor.run {
                            guard let self, self.transport === transport else { return }
                            self.sessionDrawerView.setSessions(sessions)
                        }
                    }
                    await MainActor.run {
                        guard let self, self.transport === transport else { return }
                        self.sessionDrawerView.setStatus("PTY session stream ended. Reconnecting...")
                    }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                } catch is CancellationError {
                    return
                } catch {
                    await MainActor.run {
                        guard let self, self.transport === transport else { return }
                        self.sessionDrawerView.setStatus("PTY sessions unavailable: \(error)")
                        self.logger.error("terminal session snapshot failed: \(String(describing: error), privacy: .public)")
                    }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    private func stopSessionSnapshotMonitoring() {
        sessionSnapshotTask?.cancel()
        sessionSnapshotTask = nil
    }

    private func runSessionCommand(
        status: String,
        operation: @escaping @Sendable (PtyClient) async throws -> Void,
        onSuccess: @escaping @MainActor () -> Void
    ) {
        guard let transport else {
            sessionDrawerView.setStatus("Terminal transport is disconnected.")
            return
        }
        sessionDrawerView.setStatus(status)
        Task { [weak self, weak transport] in
            do {
                guard let transport else { throw PtyClientError.closed }
                let client = try await transport.openTerminalPtyClient()
                try await operation(client)
                await MainActor.run {
                    guard let self, self.transport === transport else { return }
                    onSuccess()
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.sessionDrawerView.setStatus("PTY command failed: \(error)")
                    self.logger.error("terminal session command failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    private func removeLocalPanes(sessionName: String) {
        let paneIDs = workspaceState.allLeaves()
            .filter { $0.sessionName == sessionName }
            .map(\.paneID)
        for paneID in paneIDs {
            paneViews[paneID]?.closeAfterManagerDetach()
            removeClosedPane(paneID)
        }
    }

    private func localPaneID(sessionName: String, clientID: UInt64) -> TerminalPaneID? {
        paneViews.first(where: { _, paneView in
            paneView.leaf.sessionName == sessionName && paneView.attachedClientID == clientID
        })?.key
    }

    private func removeLocalPane(_ paneID: TerminalPaneID) {
        paneViews[paneID]?.closeAfterManagerDetach()
        removeClosedPane(paneID)
    }

    @objc private func handleSessionDrawerButton() {
        sessionDrawerView.setVisible(true)
    }
}
