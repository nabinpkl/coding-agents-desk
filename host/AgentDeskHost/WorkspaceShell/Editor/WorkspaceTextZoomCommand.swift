import AppKit

enum WorkspaceTextZoomCommand: Equatable {
    case zoomIn
    case zoomOut
    case reset

    init?(event: NSEvent) {
        guard event.type == .keyDown else { return nil }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command),
              !flags.contains(.option),
              !flags.contains(.control) else { return nil }

        let characters = [
            event.characters,
            event.charactersIgnoringModifiers,
        ].compactMap { $0?.lowercased() }

        if characters.contains("=") || characters.contains("+") || event.keyCode == Self.equalKeyCode {
            self = .zoomIn
        } else if characters.contains("-") || event.keyCode == Self.minusKeyCode {
            self = .zoomOut
        } else if characters.contains("0") || event.keyCode == Self.zeroKeyCode {
            self = .reset
        } else {
            return nil
        }
    }

    private static let equalKeyCode: UInt16 = 24
    private static let minusKeyCode: UInt16 = 27
    private static let zeroKeyCode: UInt16 = 29

    func apply(to zoom: WorkspaceTextZoom) -> WorkspaceTextZoom {
        switch self {
        case .zoomIn: zoom.zoomedIn()
        case .zoomOut: zoom.zoomedOut()
        case .reset: zoom.reset()
        }
    }
}
