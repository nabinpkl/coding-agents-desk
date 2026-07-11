import Foundation

struct FileEditorSurfaceState {
    enum Effect: Equatable {
        case render(FileEditorSurface.Payload)
        case setTextZoom(WorkspaceTextZoom)
    }

    private enum Readiness {
        case loading
        case ready
        case failed
    }

    private var readiness: Readiness = .loading
    private var queuedPayload: FileEditorSurface.Payload?
    private var zoom = WorkspaceTextZoom()

    mutating func render(_ payload: FileEditorSurface.Payload) -> [Effect] {
        queuedPayload = payload
        guard readiness == .ready else { return [] }
        return [.render(payload)]
    }

    mutating func setTextZoom(_ zoom: WorkspaceTextZoom) -> [Effect] {
        self.zoom = zoom
        guard readiness == .ready else { return [] }
        return [.setTextZoom(zoom)]
    }

    mutating func navigationStarted() {
        readiness = .loading
    }

    mutating func markFailed() {
        readiness = .failed
    }

    mutating func markReady() -> [Effect] {
        guard readiness != .ready else { return [] }
        readiness = .ready
        var effects: [Effect] = [.setTextZoom(zoom)]
        if let queuedPayload {
            effects.append(.render(queuedPayload))
        }
        return effects
    }
}
