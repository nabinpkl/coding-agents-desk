import Foundation
import Testing
@testable import AgentDeskWire

// Authoritative single-source round-trip suite for the shared wire contract
// (ADR-0050). Focuses on the shapes the extraction reconciled from drifted
// host/client copies; the per-app test targets exercise the same types in
// context, but this is the one place a wire shape is asserted independent of
// either app.

private func roundTrip<T: Codable & Equatable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    let decoded = try JSONDecoder().decode(T.self, from: data)
    #expect(decoded == value)
}

@Test func domBatchEnvelopeKeepsEmulatedField() throws {
    // Drift: the host had `emulated`, the client did not. The unified type carries
    // it, and it survives a round-trip both set and absent.
    try roundTrip(DomBatchEnvelope(tabId: 7, checkout: true, emulated: true))
    try roundTrip(DomBatchEnvelope(tabId: 7, checkout: false))
    let decoded = try JSONDecoder().decode(
        DomBatchEnvelope.self,
        from: try JSONEncoder().encode(DomBatchEnvelope(tabId: 1, checkout: false, emulated: false)))
    #expect(decoded.emulated == false)
}

@Test func ownedSurfaceUpdateIdIsHashableAndComparable() throws {
    // Drift: the host conformed Hashable, the client did not. The unified type is
    // usable as a dictionary key on both sides.
    let a = OwnedSurfaceUpdateId(surfaceGeneration: 3, frameId: 10)
    let b = OwnedSurfaceUpdateId(surfaceGeneration: 3, frameId: 11)
    var seen: [OwnedSurfaceUpdateId: Int] = [:]
    seen[a] = 1
    seen[b] = 2
    #expect(seen[a] == 1)
    #expect(a < b)
    try roundTrip(a)
}

@Test func ownedGraphicsCommandRoundTripsAllShapes() throws {
    // The enum carries a hand-written Codable conformance (moved as an extension);
    // exercise the reset, tile, and revert shapes.
    try roundTrip(OwnedGraphicsCommand.revertTileToVideo(x: 128, y: 256, width: 64, height: 64))
    try roundTrip(OwnedGraphicsCommand.resetSurface(
        surfaceGeneration: 5, width: 1920, height: 1080, pixelFormat: .bgra))
    try roundTrip(OwnedGraphicsCommand.bitmapTile(
        x: 0, y: 0, width: 32, height: 32, compression: .lzfse,
        byteRange: OwnedGraphicsByteRange(offset: 0, length: 1024)))
}

@Test func normalizedInputRoundTripsRepresentativeCases() throws {
    try roundTrip(NormalizedInput.cursorSet(displayId: "d1", x: 12.5, y: 40))
    try roundTrip(NormalizedInput.click(button: .right))
    try roundTrip(NormalizedInput.scroll(dx: 1, dy: -2, phase: .momentumBegan))
    try roundTrip(NormalizedInput.switchSpaceGesture(phase: .changed, progress: 0.5, velocityX: -3))
}

@Test func ownedGraphicsFrameAckUsesCanonicalInitOrder() throws {
    // Drift: the two copies declared the memberwise init in different orders. The
    // canonical order is (surfaceGeneration, frameId, compositorMs, ...); the wire
    // (CodingKeys) is unaffected, so a round-trip is order-independent.
    let ack = OwnedGraphicsFrameAck(
        surfaceGeneration: 4, frameId: 22, compositorMs: 1.75,
        queueDepthBytes: 16_384, queuedFrames: 2, totalGraphicsFramesApplied: 9,
        staleDiscardCount: 3)
    try roundTrip(ack)
}
