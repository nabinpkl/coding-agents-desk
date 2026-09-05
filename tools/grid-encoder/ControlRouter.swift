import Foundation

/// Who owns a control line.
enum ControlLineOwner: Equatable {
    case navigation
    case input
    case capture
    case unknown
}

/// One decode, one dispatch.
///
/// This pipe carries three vocabularies -- desktop input, space navigation and capture control --
/// and used to sort them by trying each handler in turn and seeing which claimed the line. That
/// order was the routing: desktop input claimed every line beginning with `{`, capture control got
/// whatever was left, and anything nobody claimed disappeared in silence. A line could be lost to
/// the order of the handlers rather than to anything wrong with it.
///
/// Routing on the declared type instead makes ownership explicit and total: every line belongs to
/// exactly one vocabulary or to none, and none is an answer that gets reported.
enum ControlRouter {
    /// The envelope, decoded once. Payload validation stays with whichever subsystem owns the type.
    static func type(of line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["type"] as? String
    }

    static func object(of line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object
    }

    static func owner(of type: String) -> ControlLineOwner {
        if CaptureControlCommand.types.contains(type) { return .capture }
        if DesktopSpacesController.types.contains(type) { return .navigation }
        if DesktopInputController.types.contains(type) { return .input }
        return .unknown
    }

    /// Navigation watches this one to cancel an in-flight gesture, but input owns it.
    static let sharedWithNavigation: Set<String> = ["release-control"]
}
