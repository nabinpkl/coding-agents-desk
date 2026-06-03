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

    @Test func parsesGestureState() throws {
        let state = try #require(try GestureChildController.gestureState(
            from: #"{"type":"gestureState","phase":"READY","counts":{"left":3,"right":2},"anchor":{"center":[0.48,0.42],"radius":[0.07,0.18],"near":true},"hand":{"center":[0.5,0.43],"landmarks":[[0.1,0.2],[0.3,0.4]]},"createdAt":1780000000.12}"#
        ))

        #expect(state.phase == "READY")
        #expect(state.counts.left == 3)
        #expect(state.counts.right == 2)
        #expect(state.anchor?.center == GesturePortalPoint(x: 0.48, y: 0.42))
        #expect(state.anchor?.radius == GesturePortalPoint(x: 0.07, y: 0.18))
        #expect(state.anchor?.near == true)
        #expect(state.hand?.center == GesturePortalPoint(x: 0.5, y: 0.43))
        #expect(state.hand?.landmarks.count == 2)
        #expect(state.createdAt == 1780000000.12)
    }

    @Test func parsesGestureStateWithNullGeometry() throws {
        let state = try #require(try GestureChildController.gestureState(
            from: #"{"type":"gestureState","phase":"NO_ANCHOR","counts":{"left":0,"right":0},"anchor":null,"hand":null,"createdAt":1780000000.12}"#
        ))

        #expect(state.phase == "NO_ANCHOR")
        #expect(state.anchor == nil)
        #expect(state.hand == nil)
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
