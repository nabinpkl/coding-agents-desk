import Foundation

/// The live state of one session's AskUserQuestion panel, as read from the Claude Desktop window.
///
/// Deliberately carries NO content: the question text, option labels, and multi-select shape come from
/// the transcript/live feed, where the `AskUserQuestion` tool_use already holds the full JSON. This is
/// only the augmentation a live AX read can add -- what is currently selected, what the "Other" input
/// holds, whether Submit is enabled, and whether the panel is still present at all.
struct AgentWindowQuestionState: Equatable, Sendable {
    /// Whether an AskUserQuestion panel exists in the window's accessibility tree.
    let present: Bool
    /// Indices (into the JSON `options` array) of the options currently selected or checked.
    let selectedIndices: [Int]
    /// The panel's "Other" input value; nil when the panel holds none.
    let otherText: String?
    /// The panel's Submit button enabled state; nil when the panel is absent.
    let submitEnabled: Bool?

    init(
        present: Bool,
        selectedIndices: [Int] = [],
        otherText: String? = nil,
        submitEnabled: Bool? = nil
    ) {
        self.present = present
        self.selectedIndices = selectedIndices
        self.otherText = otherText
        self.submitEnabled = submitEnabled
    }

    static let absent = AgentWindowQuestionState(present: false)
}

/// One interaction a panel requests against the AskUserQuestion panel in a Claude Desktop window.
///
/// The host domain form of the wire frame: the coordinator maps `AgentWindowQuestionOperation` (wire) into
/// this before handing it to the writer, so the writer's seam stays free of wire concerns.
enum AgentWindowQuestionOperation: Equatable, Sendable {
    /// Press (or un-press, per `desired`) the option at `option` (JSON `options` index).
    case select(option: Int, desired: Bool)
    /// Set the panel's "Other" input to `text`, checking the Other affordance when needed.
    case other(String)
    case submit
    case skip
    case dismiss
    case viewOptions
}
