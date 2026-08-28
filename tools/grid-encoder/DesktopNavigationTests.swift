import CoreGraphics
import Foundation

@main
struct DesktopNavigationTests {
    static func main() throws {
        let path = ProcessInfo.processInfo.environment["AGENTDESK_NAVIGATION_FIXTURES"]!
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
            as! [String: Any]
        let commands = fixture["commands"] as! [[String: Any]]
        let display = DesktopDisplayRecord(
            id: "DISPLAY-A", label: "External", isMain: false, captureID: 2,
            bounds: CGRect(x: -1000, y: 200, width: 1000, height: 800), activeSpaceID: 1,
            spaces: [.init(id: 1, type: 0), .init(id: 2, type: 4), .init(id: UInt64.max, type: 0)]
        )
        var displays = [display]
        var events: [CGEvent] = []
        var replies: [[String: Any]] = []
        var trusted = true
        var geometryChanges = 0
        var reads = 0
        let controller = DesktopSpacesController(
            captureDisplayID: display.id, read: { reads += 1; return displays }, trusted: { trusted },
            post: { events.append($0) }, captureGeometryChanged: { geometryChanges += 1 },
            emit: { replies.append($0) }
        )
        func send(_ value: [String: Any]) throws {
            let line = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
            precondition(controller.handle(line))
        }
        try send(commands[0])
        precondition(replies.last?["type"] as? String == "desktop-state")
        let catalog = replies.last?["displays"] as! [[String: Any]]
        precondition((catalog[0]["spaces"] as! [[String: Any]])[2]["id"] as? String == String(UInt64.max))
        let count = replies.count
        controller.refresh()
        precondition(replies.count == count, "unchanged OS state must not generate traffic")
        try send(commands[1])
        precondition(events.count == 6, "tap must cross fullscreen Spaces to reach the exact target")
        precondition(events.map { $0.getIntegerValueField(CGEventField(rawValue: 132)!) } == [1, 2, 4, 1, 2, 4])
        for event in events {
            precondition(event.location == CGPoint(x: -500, y: 600))
            precondition(event.getIntegerValueField(CGEventField(rawValue: 55)!) == 30)
            precondition(event.getIntegerValueField(CGEventField(rawValue: 110)!) == 23)
            precondition(event.getIntegerValueField(CGEventField(rawValue: 123)!) == 1)
        }
        events.removeAll()
        for command in commands.dropFirst(2) { try send(command) }
        precondition(events.map { $0.getIntegerValueField(CGEventField(rawValue: 132)!) } == [1, 2, 8])
        try send(commands[2])
        let readsAfterBegin = reads
        try send(commands[3])
        precondition(reads == readsAfterBegin, "drag frames must not enumerate topology")
        controller.cancel()
        precondition(events.last!.getIntegerValueField(CGEventField(rawValue: 132)!) == 8)
        let posted = events.count
        try send(commands[3])
        precondition(events.count == posted)
        precondition(replies.last?["reason"] as? String == "not-owner")
        trusted = false
        try send(commands[1])
        precondition(events.count == posted)
        precondition(replies.last?["reason"] as? String == "accessibility-denied")
        trusted = true
        try send(commands[2])
        precondition(!controller.handle("{\"type\":\"release-control\"}"))
        precondition(events.last!.getIntegerValueField(CGEventField(rawValue: 132)!) == 8)
        let releasedCount = events.count
        var zeroEnd = commands[3]
        zeroEnd["phase"] = "ended"
        zeroEnd["progress"] = 0
        try send(zeroEnd)
        precondition(events.count == releasedCount)
        precondition(replies.last?["reason"] as? String == "malformed")
        var boolean = commands[3]
        boolean["progress"] = true
        try send(boolean)
        precondition(events.count == releasedCount)
        precondition(replies.last?["reason"] as? String == "malformed")
        precondition(!controller.handle("K"))
        precondition(!controller.handle("B900000"))
        precondition(!controller.handle("broken JSON"))
        displays = [DesktopDisplayRecord(id: display.id, label: display.label, isMain: display.isMain,
            captureID: display.captureID, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800),
            activeSpaceID: display.activeSpaceID, spaces: display.spaces)]
        controller.refresh()
        precondition(geometryChanges == 1, "changed monitor origin must retire stale input bounds")
        displays = [display]
        try send(commands[2])
        displays = []
        controller.refresh()
        precondition(events.last!.getIntegerValueField(CGEventField(rawValue: 132)!) == 8)
        precondition((replies.last?["displays"] as? [[String: Any]])?.isEmpty == true)
        try send(commands[1])
        precondition(replies.last?["reason"] as? String == "display-unavailable")
        print("desktop navigation native contracts passed")
    }
}
