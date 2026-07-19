import Foundation

struct WorkspaceWorkbenchState: Codable, Equatable, Sendable {
    static let sidebarFractionRange: ClosedRange<Double> = 0.28...0.55
    static let terminalFractionRange: ClosedRange<Double> = 0.25...0.65
    static let defaultSidebarFraction: Double = 0.38
    static let defaultTerminalFraction: Double = 0.38

    var sidebarVisible: Bool
    var terminalVisible: Bool
    var sidebarFraction: Double
    var terminalFraction: Double
    var preferredTerminalSessionName: String?

    init(
        sidebarVisible: Bool = true,
        terminalVisible: Bool = true,
        sidebarFraction: Double = Self.defaultSidebarFraction,
        terminalFraction: Double = Self.defaultTerminalFraction,
        preferredTerminalSessionName: String? = nil
    ) {
        self.sidebarVisible = sidebarVisible
        self.terminalVisible = terminalVisible
        self.sidebarFraction = Self.sidebarFractionRange.clamped(sidebarFraction)
        self.terminalFraction = Self.terminalFractionRange.clamped(terminalFraction)
        self.preferredTerminalSessionName = preferredTerminalSessionName
    }

    mutating func setSidebarFraction(_ fraction: Double) {
        sidebarFraction = Self.sidebarFractionRange.clamped(fraction)
    }

    mutating func setTerminalFraction(_ fraction: Double) {
        terminalFraction = Self.terminalFractionRange.clamped(fraction)
    }

    private enum CodingKeys: String, CodingKey {
        case sidebarVisible, terminalVisible, sidebarFraction, terminalFraction
        case preferredTerminalSessionName
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            sidebarVisible: try values.decodeIfPresent(Bool.self, forKey: .sidebarVisible) ?? true,
            terminalVisible: try values.decodeIfPresent(Bool.self, forKey: .terminalVisible) ?? true,
            sidebarFraction: try values.decodeIfPresent(Double.self, forKey: .sidebarFraction)
                ?? Self.defaultSidebarFraction,
            terminalFraction: try values.decodeIfPresent(Double.self, forKey: .terminalFraction)
                ?? Self.defaultTerminalFraction,
            preferredTerminalSessionName: try values.decodeIfPresent(
                String.self,
                forKey: .preferredTerminalSessionName
            )
        )
    }
}

@MainActor
protocol WorkspaceWorkbenchStateStoring: AnyObject {
    func state(for workspaceID: String) -> WorkspaceWorkbenchState
    func setState(_ state: WorkspaceWorkbenchState, for workspaceID: String)
}

@MainActor
final class WorkspaceWorkbenchStateStore: WorkspaceWorkbenchStateStoring {
    static let shared = WorkspaceWorkbenchStateStore()

    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = "agentDesk.workspaceWorkbench.states"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func state(for workspaceID: String) -> WorkspaceWorkbenchState {
        allStates()[workspaceID] ?? WorkspaceWorkbenchState()
    }

    func setState(_ state: WorkspaceWorkbenchState, for workspaceID: String) {
        let states = allStates().merging([workspaceID: state]) { _, replacement in replacement }
        guard let data = try? JSONEncoder().encode(states) else { return }
        defaults.set(data, forKey: key)
    }

    private func allStates() -> [String: WorkspaceWorkbenchState] {
        guard let data = defaults.data(forKey: key),
              let states = try? JSONDecoder().decode(
                [String: WorkspaceWorkbenchState].self,
                from: data
              ) else {
            return [:]
        }
        return states
    }
}

private extension ClosedRange<Double> {
    func clamped(_ value: Double) -> Double {
        Swift.min(Swift.max(value, lowerBound), upperBound)
    }
}
