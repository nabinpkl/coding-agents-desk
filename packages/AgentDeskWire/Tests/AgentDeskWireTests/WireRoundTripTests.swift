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

@Test func clientConfigRoundTripsManualMediaQuality() throws {
    let config = ClientConfig(
        thumbnailsEnabled: true,
        selectedDisplayId: "display-1",
        crispTextOverlayEnabled: false,
        showHostCursorInVideo: true,
        mediaQuality: ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(
                bitrateKbps: 1_200,
                fps: 15,
                resolutionScale: 0.5
            )
        ),
        autoKeyboardEnabled: false
    )
    try roundTrip(config)

    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(config)
    ) as? [String: Any]
    let mediaQuality = object?["mq"] as? [String: Any]
    let fixedTarget = mediaQuality?["ft"] as? [String: Any]
    #expect(mediaQuality?["a"] as? Bool == false)
    #expect(fixedTarget?["bk"] as? Int == 1_200)
    #expect(fixedTarget?["fps"] as? Int == 15)
    #expect(fixedTarget?["rs"] as? Double == 0.5)
    #expect(object?["ak"] as? Bool == false)
}

@Test func clientConfigDefaultsAutoKeyboardEnabledWhenMissing() throws {
    let data = Data(#"{"t":"client-config","te":false}"#.utf8)
    let decoded = try JSONDecoder().decode(ClientConfig.self, from: data)
    #expect(decoded.autoKeyboardEnabled)
}

@Test func hostAvailabilityPushRoundTripsLockedAndCaptureUnavailable() throws {
    try roundTrip(HostAvailabilityPush(availability: .locked, reason: "session-resigned-active"))
    try roundTrip(HostAvailabilityPush(availability: .captureUnavailable, reason: "media-closed"))

    let data = try JSONEncoder().encode(HostAvailabilityPush(availability: .active))
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(object?["t"] as? String == "host-availability")
    #expect(object?["a"] as? String == "active")
}

@Test func cursorKindAndTextInputFocusPushUseCompactKeys() throws {
    let cursor = CursorImagePush(
        hash: "abc123",
        png: nil,
        hotspotXFrac: 0.25,
        hotspotYFrac: 0.5,
        widthPoints: 16,
        heightPoints: 24,
        hidden: false,
        cursorKind: .ibeam
    )
    try roundTrip(cursor)
    let cursorObject = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(cursor)
    ) as? [String: Any]
    #expect(cursorObject?["k"] as? String == "ibeam")

    let focus = HostTextInputFocusPush(
        editability: .editable,
        secure: true,
        source: .accessibility,
        role: "AXTextField",
        subrole: "AXSecureTextField",
        cursorKind: .ibeam
    )
    try roundTrip(focus)
    let focusObject = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(focus)
    ) as? [String: Any]
    #expect(focusObject?["t"] as? String == "text-input-focus")
    #expect(focusObject?["e"] as? String == "editable")
    #expect(focusObject?["s"] as? Bool == true)
    #expect(focusObject?["src"] as? String == "accessibility")
    #expect(focusObject?["r"] as? String == "AXTextField")
    #expect(focusObject?["sr"] as? String == "AXSecureTextField")
    #expect(focusObject?["k"] as? String == "ibeam")
}

@Test func sessionRejectedRoundTripsSigningKeyUnavailableReason() throws {
    try roundTrip(SessionRejected(reason: .signingKeyUnavailable))
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
