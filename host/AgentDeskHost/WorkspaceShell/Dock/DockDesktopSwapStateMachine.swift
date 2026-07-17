import Foundation

struct DockDesktopSwapSelection: Equatable, Sendable {
    let spaceID: UInt64
    let desktopLabel: String
    let monitorBadgeLabel: String

    var displayLabel: String {
        "\(monitorBadgeLabel) · \(desktopLabel)"
    }
}

struct DockDesktopSwapCompletion: Equatable, Sendable {
    let source: DockDesktopSwapSelection
    let destination: DockDesktopSwapSelection
    let receipt: DockDesktopSwapReceipt
}

enum DockDesktopSwapState: Equatable, Sendable {
    case idle
    case choosingSource
    case choosingDestination(source: DockDesktopSwapSelection)
    case swapping(source: DockDesktopSwapSelection, destination: DockDesktopSwapSelection)
    case undoAvailable(DockDesktopSwapCompletion)
    case undoing(DockDesktopSwapCompletion)
    case failed(String)

    var holdsDock: Bool {
        self != .idle
    }

    var isSelecting: Bool {
        switch self {
        case .choosingSource, .choosingDestination:
            return true
        default:
            return false
        }
    }

    var isBusy: Bool {
        switch self {
        case .swapping, .undoing:
            return true
        default:
            return false
        }
    }

    var instruction: String? {
        switch self {
        case .idle:
            return nil
        case .choosingSource:
            return "Choose desktop 1"
        case .choosingDestination(let source):
            return "1 \(source.displayLabel) selected. Choose desktop 2"
        case .swapping(let source, let destination):
            return "Swapping \(source.displayLabel) and \(destination.displayLabel)"
        case .undoAvailable(let completion):
            return "Swapped \(completion.source.displayLabel) and \(completion.destination.displayLabel)"
        case .undoing(let completion):
            return "Restoring \(completion.source.displayLabel) and \(completion.destination.displayLabel)"
        case .failed(let message):
            return message
        }
    }

    func marker(for spaceID: UInt64) -> String? {
        switch self {
        case .choosingSource:
            return "1"
        case .choosingDestination(let source):
            return source.spaceID == spaceID ? "1" : "2"
        case .swapping(let source, let destination):
            if source.spaceID == spaceID { return "1" }
            if destination.spaceID == spaceID { return "2" }
            return nil
        case .undoAvailable(let completion), .undoing(let completion):
            if completion.source.spaceID == spaceID { return "1" }
            if completion.destination.spaceID == spaceID { return "2" }
            return nil
        case .idle, .failed:
            return nil
        }
    }

    func isSelected(spaceID: UInt64) -> Bool {
        switch self {
        case .choosingDestination(let source):
            return source.spaceID == spaceID
        case .swapping(let source, let destination):
            return source.spaceID == spaceID || destination.spaceID == spaceID
        case .undoAvailable(let completion), .undoing(let completion):
            return completion.source.spaceID == spaceID || completion.destination.spaceID == spaceID
        case .idle, .choosingSource, .failed:
            return false
        }
    }
}

enum DockDesktopSwapEvent: Equatable, Sendable {
    case toggle
    case select(DockDesktopSwapSelection)
    case swapSucceeded(DockDesktopSwapReceipt)
    case undo
    case undoSucceeded
    case undoExpired
    case operationFailed(String)
    case cancel
}

enum DockDesktopSwapEffect: Equatable, Sendable {
    case swap(sourceSpaceID: UInt64, destinationSpaceID: UInt64)
    case undo(DockDesktopSwapReceipt)
}

struct DockDesktopSwapStateMachine: Equatable, Sendable {
    private(set) var state: DockDesktopSwapState = .idle

    mutating func send(_ event: DockDesktopSwapEvent) -> DockDesktopSwapEffect? {
        switch event {
        case .toggle:
            guard !state.isBusy else { return nil }
            state = state == .idle ? .choosingSource : .idle
        case .select(let selection):
            switch state {
            case .choosingSource:
                state = .choosingDestination(source: selection)
            case .choosingDestination(let source):
                guard source.spaceID != selection.spaceID else {
                    state = .choosingSource
                    return nil
                }
                state = .swapping(source: source, destination: selection)
                return .swap(sourceSpaceID: source.spaceID, destinationSpaceID: selection.spaceID)
            default:
                break
            }
        case .swapSucceeded(let receipt):
            guard case .swapping(let source, let destination) = state else { return nil }
            state = .undoAvailable(.init(source: source, destination: destination, receipt: receipt))
        case .undo:
            guard case .undoAvailable(let completion) = state else { return nil }
            state = .undoing(completion)
            return .undo(completion.receipt)
        case .undoSucceeded:
            guard case .undoing = state else { return nil }
            state = .idle
        case .undoExpired, .cancel:
            guard !state.isBusy else { return nil }
            state = .idle
        case .operationFailed(let message):
            state = .failed(message)
        }
        return nil
    }
}
