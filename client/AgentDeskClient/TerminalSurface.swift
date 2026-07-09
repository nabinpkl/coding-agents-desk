import Foundation
import os
import UIKit

@available(iOS 26.0, *)
final class TerminalSurface: UIView, @MainActor TerminalPaneViewDelegate {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal-surface")
    private let workspaceContainer = UIView()
    private var transport: QuicSessionClientTransport?
    private var workspaceState = TerminalWorkspaceState()
    private var paneViews: [TerminalPaneID: TerminalPaneView] = [:]
    private var closingPaneIDs = Set<TerminalPaneID>()
    private var renderedRootView: UIView?

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
        }
        self.transport = transport
        for leaf in workspaceState.allLeaves() {
            paneViews[leaf.paneID]?.connect(using: transport)
        }
    }

    func detach() {
        for paneView in paneViews.values {
            paneView.detach()
        }
        transport = nil
    }

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

    private func configureView() {
        backgroundColor = .black
        workspaceContainer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(workspaceContainer)
        NSLayoutConstraint.activate([
            workspaceContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            workspaceContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            workspaceContainer.topAnchor.constraint(equalTo: topAnchor),
            workspaceContainer.bottomAnchor.constraint(equalTo: bottomAnchor)
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
            paneView?.setFocused(leaf.paneID == workspaceState.focusedPaneID)
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
}
