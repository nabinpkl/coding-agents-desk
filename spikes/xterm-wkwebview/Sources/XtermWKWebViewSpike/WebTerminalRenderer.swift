import Foundation
import PtyClientSwift
import PtyTerminalSession

@MainActor
final class WebTerminalRenderer: PtyTerminalRenderer {
    let terminalID: String
    weak var controller: XtermSpikeWindowController?

    init(terminalID: String, controller: XtermSpikeWindowController) {
        self.terminalID = terminalID
        self.controller = controller
    }

    func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        controller?.deliver([
            "type": "checkpoint-begin",
            "terminalId": terminalID,
            "checkpointId": checkpoint.checkpointID,
            "revision": checkpoint.revision,
            "columns": checkpoint.columns,
            "rows": checkpoint.rows,
            "historyTruncated": checkpoint.historyTruncated,
        ])
    }

    func feedCheckpointChunk(_ data: Data) {
        deliverData(type: "checkpoint-chunk", data: data)
    }

    func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        controller?.deliver([
            "type": "checkpoint-end",
            "terminalId": terminalID,
            "checkpointId": checkpoint.checkpointID,
            "revision": checkpoint.revision,
        ])
        controller?.rendererDidSynchronize(terminalID: terminalID)
    }

    func feedOutput(_ data: Data, revision: UInt64) {
        deliverData(type: "output", data: data, revision: revision)
    }

    func updateViewportStatus(_ status: PtyTerminalViewportStatus) {
        controller?.deliver([
            "type": "viewport-status",
            "terminalId": terminalID,
            "ownershipEpoch": status.ownershipEpoch,
            "ownerClientId": status.ownerClientID,
            "ownerTitle": status.ownerTitle,
            "isOwner": status.isOwner,
            "sourceColumns": status.sourceDimensions.columns,
            "sourceRows": status.sourceDimensions.rows,
            "sourceRevision": status.sourceRevision,
            "viewColumns": status.viewDimensions.columns,
            "viewRows": status.viewDimensions.rows,
        ])
    }

    func feedStatus(_ text: String) {
        controller?.deliver([
            "type": "status",
            "terminalId": terminalID,
            "text": text,
        ])
    }

    func closeAfterManagerDetach() {
        controller?.deliver([
            "type": "closed",
            "terminalId": terminalID,
        ])
    }

    private func deliverData(type: String, data: Data, revision: UInt64? = nil) {
        var message: [String: Any] = [
            "type": type,
            "terminalId": terminalID,
            "data": data.base64EncodedString(),
        ]
        if let revision { message["revision"] = revision }
        controller?.deliver(message)
    }
}
