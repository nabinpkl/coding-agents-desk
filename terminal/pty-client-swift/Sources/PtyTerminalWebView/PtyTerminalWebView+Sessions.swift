import Foundation
import PtyClientSwift
import PtyTerminalSession

extension PtyTerminalWebView {
    func open(pane original: PtyTerminalPane) {
        guard let backend else { return }
        var pane = original
        if pane.sessionName.isEmpty {
            guard let assigned = workspaceState.assignSessionName(backend.makeFreshSessionName(), to: pane.paneID) else { return }
            pane = assigned
        }
        let dimensions = selectedSlot?.dimensions ?? .bootstrap
        Task { [weak self, weak backend] in
            do {
                guard let self, let backend else { return }
                let connection = try await backend.openSession(.init(
                    sessionName: pane.sessionName, createIfMissing: pane.createIfMissing, dimensions: dimensions
                ))
                guard self.workspaceState.panes.contains(where: { $0.terminalID == pane.terminalID }) else {
                    try? await connection.detach(); return
                }
                self.bind(connection: connection, concreteConnection: connection, to: pane)
                self.sendWorkspaceSnapshot()
            } catch {
                guard let self else { return }
                self.delegate?.ptyTerminalContent(self, didFail: error)
            }
        }
    }

    func bind(connection: PtyTerminalConnection, concreteConnection: PtySessionConnection?, to pane: PtyTerminalPane) {
        let slot = Slot(paneID: pane.paneID, terminalID: pane.terminalID, owner: self)
        slot.connection = connection
        slot.concreteConnection = concreteConnection
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: slot.renderer) { [weak self] termination in
            guard let self else { return }
            self.delegate?.ptyTerminalContent(self, didTerminate: termination, terminalID: pane.terminalID)
        } onError: { [weak self] error in
            guard let self else { return }
            self.delegate?.ptyTerminalContent(self, didFail: error)
        }
        slot.driver = driver
        slots[pane.terminalID] = slot
        isBound = true
        driver.start()
        if viewportPresented && workspaceState.selectedPane?.terminalID == pane.terminalID {
            let shouldClaim = pendingViewportClaimPaneID == pane.paneID
                && slot.hasSettledViewportDimensions
            driver.updateViewerState(
                active: true,
                claim: shouldClaim,
                dimensions: viewportAuthorityDimensions(for: slot)
            )
            if shouldClaim { pendingViewportClaimPaneID = nil }
        }
    }

    func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint, terminalID: String) {
        guard let slot = slots[terminalID] else { return }
        slot.synchronizing = true; slot.columns = checkpoint.columns; slot.rows = checkpoint.rows
        isSynchronizing = true
        deliver([
            "type": "checkpointBegin", "terminalId": terminalID, "checkpointId": checkpoint.checkpointID,
            "revision": checkpoint.revision, "columns": checkpoint.columns, "rows": checkpoint.rows,
        ], terminalID: terminalID)
    }

    func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint, terminalID: String) {
        guard let slot = slots[terminalID] else { return }
        slot.synchronizing = false; slot.revision = checkpoint.revision
        isSynchronizing = slots.values.contains(where: \.synchronizing)
        appliedRevision = selectedSlot?.revision ?? 0
        deliver([
            "type": "checkpointEnd", "terminalId": terminalID, "checkpointId": checkpoint.checkpointID,
            "revision": checkpoint.revision, "historyTruncated": checkpoint.historyTruncated,
        ], terminalID: terminalID)
    }

    func deliverData(type: String, data: Data, terminalID: String, revision: UInt64? = nil, liveOutput: Bool = false) {
        var object: [String: Any] = ["type": type, "terminalId": terminalID, "data": data.base64EncodedString()]
        if let revision {
            object["revision"] = revision
            slots[terminalID]?.revision = revision
            if selectedSlot?.terminalID == terminalID { appliedRevision = revision }
        }
        deliver(object, terminalID: terminalID, liveOutput: liveOutput)
    }

    func updateViewportStatus(_ status: PtyTerminalViewportStatus, terminalID: String) {
        guard let slot = slots[terminalID] else { return }
        slot.viewportStatus = status
        if selectedSlot === slot { viewportStatus = status }
        deliver([
            "type": "viewportStatus", "terminalId": terminalID, "ownershipEpoch": status.ownershipEpoch,
            "ownerClientId": status.ownerClientID, "ownerTitle": status.ownerTitle, "isOwner": status.isOwner,
            "sourceColumns": status.sourceDimensions.columns, "sourceRows": status.sourceDimensions.rows,
            "sourceRevision": status.sourceRevision, "viewColumns": status.viewDimensions.columns,
            "viewRows": status.viewDimensions.rows,
        ], terminalID: terminalID)
    }

    func feedStatus(_ text: String, terminalID: String) {
        delegate?.ptyTerminalContent(self, didReceiveStatus: text)
        deliver(["type": "status", "terminalId": terminalID, "text": String(text.prefix(4_096))], terminalID: terminalID)
    }

    func closeAfterManagerDetach(terminalID: String) {
        deliver(["type": "closed", "terminalId": terminalID], terminalID: terminalID)
        slots[terminalID]?.driver?.stop()
        slots.removeValue(forKey: terminalID)
        isBound = !slots.isEmpty
        delegate?.ptyTerminalContentDidDetachByManager(self, terminalID: terminalID)
    }

    func handleWorkspaceIntent(name: String, paneID: String?, tabID: String?, sessionName: String?) {
        guard profile == .workspace else { return }
        var paneToOpen: PtyTerminalPane?
        switch name {
        case "addTab": paneToOpen = workspaceState.addTab()
        case "splitHorizontal", "splitVertical":
            if let paneID { _ = workspaceState.focusPane(paneID) }
            paneToOpen = workspaceState.splitFocusedPane(axis: name == "splitHorizontal" ? .horizontal : .vertical)
        case "selectTab": if let tabID { _ = workspaceState.selectTab(tabID) }
        case "closeTab": if let tabID { closeTab(tabID) }
        case "closePane": if let paneID { closePane(paneID) }
        case "openSession": if let sessionName { paneToOpen = workspaceState.openExistingSession(sessionName) }
        case "killSession": if let sessionName { killSession(named: sessionName) }
        case "showSessions": sendSessionDrawer()
        default: return
        }
        if let selectedPane = workspaceState.selectedPane { pendingViewportClaimPaneID = selectedPane.paneID }
        updateSlotParticipation(claimSelected: true)
        sendWorkspaceSnapshot()
        if let paneToOpen { open(pane: paneToOpen) }
        delegate?.ptyTerminalContent(self, didUpdateWorkspace: workspaceState)
    }

    func closePane(_ paneID: String) {
        guard let pane = workspaceState.panes.first(where: { $0.paneID == paneID }) else { return }
        let slot = slots.removeValue(forKey: pane.terminalID)
        slot?.driver?.stop()
        closeSessionForRemovedPane(pane, connection: slot?.concreteConnection)
        _ = workspaceState.closePane(paneID)
        if let replacement = workspaceState.panes.first(where: { slots[$0.terminalID] == nil }) { open(pane: replacement) }
    }

    func closeTab(_ tabID: String) {
        guard let removedPanes = workspaceState.closeTab(tabID) else { return }
        for pane in removedPanes {
            let slot = slots.removeValue(forKey: pane.terminalID)
            slot?.driver?.stop()
            closeSessionForRemovedPane(pane, connection: slot?.concreteConnection)
        }
        if let replacement = workspaceState.panes.first(where: { slots[$0.terminalID] == nil }) {
            open(pane: replacement)
        }
    }

    /// Ends a session from the drawer. Sessions outlive the surfaces that showed them, so a session
    /// nothing is attached to is not garbage the manager should collect on a timer - it is a running
    /// process only its owner can decide about. This is that decision, made explicitly.
    func killSession(named sessionName: String) {
        guard let backend else { return }
        Task { [weak self, weak backend] in
            guard let backend else { return }
            do {
                try await backend.killSession(named: sessionName)
                guard let self else { return }
                // The snapshot stream will catch up on its own, but the drawer only renders when
                // asked, so drop the row now rather than leaving a dead session on screen.
                self.latestSessions.removeAll { $0.name == sessionName }
                self.sendSessionDrawer()
            } catch {
                guard let self else { return }
                self.delegate?.ptyTerminalContent(self, didFail: error)
            }
        }
    }

    func closeSessionForRemovedPane(_ pane: PtyTerminalPane, connection: PtySessionConnection?) {
        guard let backend else {
            Task { if let connection { try? await connection.detach() } }
            return
        }
        Task { [weak self, weak backend] in
            guard let backend else { return }
            do {
                let sessions = try await backend.listSessions()
                let session = sessions.first { $0.name == pane.sessionName }
                if let session, session.clientCount <= 1 {
                    try await backend.killSession(named: session.name)
                } else if let connection {
                    try await connection.detach()
                }
            } catch {
                if let connection { try? await connection.detach() }
                if let self { self.delegate?.ptyTerminalContent(self, didFail: error) }
            }
        }
    }

    func startSessionSnapshots() {
        sessionsTask?.cancel()
        guard let backend else { return }
        sessionsTask = Task { [weak self, weak backend] in
            do {
                guard let backend else { return }
                for try await sessions in try await backend.sessionSnapshots() {
                    guard let self else { return }
                    self.latestSessions = Array(sessions.prefix(64))
                }
            } catch {
                guard let self else { return }
                self.delegate?.ptyTerminalContent(self, didFail: error)
            }
        }
    }

    func sendSessionDrawer() {
        let sessions = latestSessions.map { session -> [String: Any] in
            let state = session.state == .running ? "running" : "exited"
            return ["name": session.name, "state": state, "clientCount": session.clientCount]
        }
        let orphanCount = latestSessions.filter { $0.state == .running && $0.clients.isEmpty }.count
        let status: String
        if sessions.isEmpty {
            status = "No PTY sessions"
        } else if orphanCount > 0 {
            status = "\(orphanCount) detached — still running, nothing attached"
        } else {
            status = ""
        }
        deliver(["type": "sessionDrawer", "sessions": sessions, "status": status])
    }

    func updateSlotParticipation(claimSelected: Bool) {
        let selectedTerminalID = workspaceState.selectedPane?.terminalID
        let visibleTerminalIDs = Set(workspaceState.visiblePanes.map(\.terminalID))
        for slot in slots.values {
            let active = viewportPresented && visibleTerminalIDs.contains(slot.terminalID)
            let selected = slot.terminalID == selectedTerminalID
            if active && selected && claimSelected && !slot.hasSettledViewportDimensions {
                pendingViewportClaimPaneID = slot.paneID
            }
            let shouldClaim = active && selected && claimSelected
                && slot.hasSettledViewportDimensions
            slot.driver?.updateViewerState(
                active: active,
                claim: shouldClaim,
                dimensions: viewportAuthorityDimensions(for: slot)
            )
            if shouldClaim { pendingViewportClaimPaneID = nil }
        }
    }
}
