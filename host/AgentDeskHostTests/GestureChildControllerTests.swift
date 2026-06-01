import Foundation
import Testing

struct GestureChildControllerTests {
    @Test func parsesValidSpaceStep() throws {
        let left = try GestureChildController.spaceStepDelta(
            from: #"{"type":"spaceStep","delta":-1,"confidence":0.91}"#
        )
        let right = try GestureChildController.spaceStepDelta(
            from: #"{"type":"spaceStep","delta":1,"confidence":0.91}"#
        )

        #expect(left == -1)
        #expect(right == 1)
    }

    @Test func ignoresLifecycleMessages() throws {
        let hello = try GestureChildController.spaceStepDelta(
            from: #"{"type":"hello","protocol":1,"name":"gesture-agent"}"#
        )
        let ready = try GestureChildController.spaceStepDelta(
            from: #"{"type":"ready","protocol":1}"#
        )
        let status = try GestureChildController.spaceStepDelta(
            from: #"{"type":"status","state":"ready"}"#
        )

        #expect(hello == nil)
        #expect(ready == nil)
        #expect(status == nil)
    }

    @Test func rejectsInvalidDelta() {
        #expect(throws: GestureChildControllerError.invalidDelta(2)) {
            _ = try GestureChildController.spaceStepDelta(
                from: #"{"type":"spaceStep","delta":2}"#
            )
        }
    }

    @Test func rejectsUnknownType() {
        #expect(throws: GestureChildControllerError.unsupportedType("key")) {
            _ = try GestureChildController.spaceStepDelta(
                from: #"{"type":"key","code":"ansi-A"}"#
            )
        }
    }

    @Test func handlesChunkedStdoutLines() {
        var committed: [Int] = []
        let controller = GestureChildController(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            minimumStepInterval: 0,
            commitStep: { committed.append($0) }
        )

        controller.receiveStdout(Data(#"{"type":"spaceStep","delta":"#.utf8))
        controller.receiveStdout(Data((#"-1}"# + "\n").utf8))

        #expect(committed == [-1])
    }
}
