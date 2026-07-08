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
        guard let removedLeaf = workspaceState.closePane(paneView.leaf.paneID) else { return }
        paneViews[removedLeaf.paneID]?.detach()
        paneViews[removedLeaf.paneID] = nil
        renderWorkspace()
        applyFocus()
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
            paneView?.setCloseEnabled(workspaceState.leafCount > 1)
        }
    }
}
