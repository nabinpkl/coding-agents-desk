import Foundation
import PtyClientSwift
import PtyTerminalSession
import WebKit

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

extension PtyTerminalWebView {
    func sendWorkspaceSnapshot(completion: (() -> Void)? = nil) {
        let snapshot: [String: Any] = ["type": "workspaceSnapshot", "snapshot": workspaceState.snapshotObject()]
        if let completion {
            directDeliver(snapshot, completion: completion)
        } else {
            deliver(snapshot)
        }
    }

    func deliver(_ object: [String: Any], terminalID: String? = nil, liveOutput: Bool = false) {
        var message = object; message["version"] = 1
        guard JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else { return }
        let delivery = PtyTerminalWebDelivery(terminalID: terminalID, json: json, byteCount: data.count, liveOutput: liveOutput)
        guard deliveryQueue.append(delivery) else {
            recoverRenderer(terminalID: terminalID, error: .bridgeOverflow(terminalID ?? "workspace")); return
        }
        drainDeliveries()
    }

    func directDeliver(_ object: [String: Any], completion: (() -> Void)? = nil) {
        var message = object; message["version"] = 1
        guard JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.agentDeskTerminal?.receive(\(json))") { [weak self] _, error in
            Task { @MainActor in
                if error != nil { self?.recoverRenderer(terminalID: nil, error: .javascriptEvaluationFailed) }
                else { completion?() }
            }
        }
    }

    func drainDeliveries() {
        guard runtimeReady, !deliveryInFlight, let delivery = deliveryQueue.popFirst() else { return }
        deliveryInFlight = true
        webView.evaluateJavaScript("window.agentDeskTerminal?.receive(\(delivery.json))") { [weak self] _, error in
            Task { @MainActor in
                guard let self else { return }
                self.deliveryInFlight = false
                if error != nil { self.recoverRenderer(terminalID: delivery.terminalID, error: .javascriptEvaluationFailed) }
                else { self.drainDeliveries() }
            }
        }
    }

    func recoverRenderer(terminalID _: String?, error: PtyTerminalWebViewError) {
        delegate?.ptyTerminalContent(self, didFail: error)
        deliveryQueue.removeAll()
        slots.values.forEach { $0.driver?.pauseAndRequestCheckpoint() }
        guard !reloadScheduled else { return }
        reloadScheduled = true
        runtimeReady = false
        deliveryInFlight = false
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard let self, !self.isTornDown else { return }
            self.reloadScheduled = false
            self.loadRuntime()
        }
    }

    func handle(_ intent: PtyTerminalWebIntent) {
        switch intent {
        case .booted:
            directDeliver(["type": "runtimeConfiguration", "profile": profile.rawValue])
        case .ready:
            runtimeReady = true
            deliveryInFlight = true
            sendWorkspaceSnapshot { [weak self] in
                self?.deliveryInFlight = false
                self?.drainDeliveries()
            }
        case .fontReady: flushViewportResize()
        case .viewport(let terminalID, let active, let claim, let columns, let rows):
            guard let slot = slots[terminalID] else { return }
            guard columns >= 2, rows >= 2 else {
                delegate?.ptyTerminalContent(
                    self,
                    didReceiveStatus: "ignored unsettled terminal viewport \(columns)x\(rows)"
                )
                return
            }
            slot.dimensions = PtyTerminalDimensions(columns: columns, rows: rows)
            slot.hasSettledViewportDimensions = true
            let shouldClaimPending = active
                && viewportPresented
                && workspaceState.selectedPane?.terminalID == terminalID
                && pendingViewportClaimPaneID == slot.paneID
            slot.driver?.updateViewerState(
                active: active && viewportPresented,
                claim: (claim && viewportPresented) || shouldClaimPending,
                dimensions: slot.dimensions
            )
            if shouldClaimPending { pendingViewportClaimPaneID = nil }
        case .focus(let paneID, let claim):
            guard workspaceState.focusPane(paneID) else { return }
            updateSlotParticipation(claimSelected: claim)
            delegate?.ptyTerminalContent(self, didUpdateWorkspace: workspaceState)
        case .input(let terminalID, let data):
            guard isInputEnabled, let slot = slots[terminalID] else { return }
            _ = workspaceState.focusPane(slot.paneID)
            updateSlotParticipation(claimSelected: false)
            slot.driver?.sendInput(data, viewerDimensions: viewportAuthorityDimensions(for: slot))
        case .workspace(let name, let paneID, let tabID, let sessionName):
            handleWorkspaceIntent(name: name, paneID: paneID, tabID: tabID, sessionName: sessionName)
        case .clipboardWrite(let text): writeClipboard(text)
        case .openLink(let url): openExternal(url)
        case .title(let terminalID, let title):
            guard slots[terminalID] != nil else { return }
            delegate?.ptyTerminalContent(self, didSetTitle: title)
        case .rendererFailure(let terminalID): recoverRenderer(terminalID: terminalID, error: .javascriptEvaluationFailed)
        case .diagnostic(let code): delegate?.ptyTerminalContent(self, didReceiveStatus: "terminal web diagnostic: \(code)")
        case .presentation(let terminalID, let scale, let cropped):
            guard selectedSlot?.terminalID == terminalID else { return }
            fitScale = CGFloat(scale)
            isViewportCropped = cropped
        }
    }

    func writeClipboard(_ text: String) {
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    func openExternal(_ url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else { return }
        #if canImport(AppKit)
        NSWorkspace.shared.open(url)
        #elseif canImport(UIKit)
        UIApplication.shared.open(url)
        #endif
    }
}

extension PtyTerminalWebView: WKScriptMessageHandler {
    nonisolated public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let intent = PtyTerminalWebIntent.decode(message.body) else {
                self.delegate?.ptyTerminalContent(self, didFail: PtyTerminalWebViewError.invalidBridgeMessage); return
            }
            self.handle(intent)
        }
    }
}

extension PtyTerminalWebView: WKNavigationDelegate {
    nonisolated public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        Task { @MainActor [weak self] in self?.recoverRenderer(terminalID: nil, error: .resourceUnavailable) }
    }

    nonisolated public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        Task { @MainActor [weak self] in self?.recoverRenderer(terminalID: nil, error: .resourceUnavailable) }
    }

    nonisolated public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Task { @MainActor [weak self] in self?.recoverRenderer(terminalID: nil, error: .javascriptEvaluationFailed) }
    }
}

final class PtyTerminalScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler & AnyObject)?

    init(target: any WKScriptMessageHandler & AnyObject) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
