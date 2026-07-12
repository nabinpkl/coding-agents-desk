import Testing
import AgentDeskWire
@testable import WorkspaceKit

// Skeleton smoke test (R36): proves the module builds, imports AgentDeskWire, and that a
// shared wire type is reachable from the package. Real data-model coverage lands in Phase B.
struct WorkspaceKitTests {
    @Test func exposesWireProtocolVersion() {
        #expect(WorkspaceKit.wireProtocolVersion == WireProtocol.version)
    }
}
