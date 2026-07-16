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

@Test func quicSessionTerminalRoleIsPinnedAndRoundTrips() throws {
    #expect(QuicSessionStreamRole.terminal.rawValue == 5)
    #expect(QuicSessionStreamRole(rawValue: 5) == .terminal)

    let payload = Data([0x08, 0x01, 0x12, 0x04, 0x68, 0x6f, 0x6d, 0x65])
    let encoded = try QuicSessionStreamFrame.encode(role: .terminal, payload: payload)
    let decoded = try QuicSessionStreamFrame.decode(encoded)

    #expect(decoded.role == .terminal)
    #expect(decoded.payload == payload)
}

@Test func quicSessionFilesRoleIsPinnedAndRoundTrips() throws {
    #expect(QuicSessionStreamRole.files.rawValue == 6)
    #expect(QuicSessionStreamRole(rawValue: 6) == .files)

    let payload = Data(#"{"t":"files-workspaces"}"#.utf8)
    let encoded = try QuicSessionStreamFrame.encode(role: .files, payload: payload)
    let decoded = try QuicSessionStreamFrame.decode(encoded)

    #expect(decoded.role == .files)
    #expect(decoded.payload == payload)
}

@Test func wireProtocolFilesVersionIsPinned() {
    #expect(WireProtocol.version == 8)
    #expect(WireProtocol.minCompatibleVersion == 8)
}

@Test func workspaceFilesCodecCarriesDocumentBytesWithoutJSONBase64() throws {
    let bytes = Data([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    let response = WorkspaceFileResponse.read(
        requestID: WorkspaceFileRequestID(value: "docx"),
        result: WorkspaceFileReadResult(
            workspaceID: "workspace-a",
            path: "Report.docx",
            content: .document(bytes),
            revision: WorkspaceFileRevision(digest: "sha256:docx")
        )
    )

    let encoded = try WorkspaceFilesCodec.encode(response)
    #expect(encoded.starts(with: Data("bplist".utf8)))
    guard case .read(_, let decoded) = try WorkspaceFilesCodec.decodeResponse(encoded) else {
        Issue.record("expected document read")
        return
    }
    #expect(decoded.document == bytes)
    #expect(decoded.text == nil)
    #expect(encoded.count < bytes.base64EncodedString().utf8.count + 200)
}

@Test func agentTerminalMessagesRoundTripWithContextIdentityAndNoLaunchText() throws {
    let context = AgentResumeTerminalContext(
        projectPath: "/Users/dev/project; $(never)",
        source: "claude",
        harnessSessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    )
    let requestID = "request-1"
    let sessionName = "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    let clientMessages: [AgentTerminalClientMessage] = [
        .open(AgentTerminalOpen(requestID: requestID, context: context)),
        .attached(AgentTerminalAttachedAck(
            requestID: requestID,
            context: context,
            ptySessionName: sessionName
        )),
        .close(AgentTerminalClose(
            requestID: requestID,
            context: context,
            ptySessionName: sessionName,
            reason: "context-changed"
        )),
    ]
    let hostMessages: [AgentTerminalHostMessage] = [
        .ready(AgentTerminalReady(
            requestID: requestID,
            context: context,
            ptySessionName: sessionName
        )),
        .ended(AgentTerminalEnded(
            requestID: requestID,
            context: context,
            ptySessionName: sessionName,
            exitStatus: 0
        )),
        .error(AgentTerminalError(
            requestID: requestID,
            context: context,
            ptySessionName: sessionName,
            code: .activeElsewhere
        )),
    ]

    for message in clientMessages {
        try roundTrip(message)
    }
    for message in hostMessages {
        try roundTrip(message)
    }

    let encoded = try clientMessages.map { try JSONEncoder().encode($0) }
    let tags = try encoded.map {
        (try JSONSerialization.jsonObject(with: $0) as? [String: Any])?["t"] as? String
    }
    #expect(tags == [
        "agent-terminal-open",
        "agent-terminal-attached",
        "agent-terminal-close",
    ])
    for data in encoded {
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["rid"] as? String == requestID)
        #expect((object["ctx"] as? [String: Any])?["pp"] as? String == context.projectPath)
        let json = String(decoding: data, as: UTF8.self)
        #expect(!json.contains("executable"))
        #expect(!json.contains("arguments"))
        #expect(!json.contains("command"))
        #expect(!json.contains("/bin/zsh"))
    }
}

@Test func agentTerminalErrorCodesAreExhaustiveAndStable() throws {
    #expect(AgentTerminalErrorCode.allCases.map(\.rawValue) == [
        "invalidContext",
        "activeElsewhere",
        "launchFailed",
        "handoffTimedOut",
        "sessionEnded",
    ])
    for code in AgentTerminalErrorCode.allCases {
        try roundTrip(code)
    }
}

@Test func workspaceFileRequestsRoundTripWithCompactKeys() throws {
    let revision = WorkspaceFileRevision(digest: "sha256:before")
    let requestIDs = [
        WorkspaceFileRequestID(value: "request-workspaces"),
        WorkspaceFileRequestID(value: "request-directory"),
        WorkspaceFileRequestID(value: "request-read"),
        WorkspaceFileRequestID(value: "request-write"),
    ]
    let values: [WorkspaceFileRequest] = [
        .listWorkspaces(requestID: requestIDs[0]),
        .listDirectory(requestID: requestIDs[1], workspaceID: "workspace-a", path: "Sources"),
        .read(requestID: requestIDs[2], workspaceID: "workspace-a", path: "Sources/App.swift"),
        .write(
            requestID: requestIDs[3],
            workspaceID: "workspace-a",
            path: "Sources/App.swift",
            expectedRevision: revision,
            text: "print(\"hello\")\n"
        ),
    ]

    for value in values {
        try roundTrip(value)
    }

    let object = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(values[3])
    ) as? [String: Any]
    #expect(object?["t"] as? String == "files-write")
    #expect(object?["rid"] as? String == "request-write")
    #expect(object?["w"] as? String == "workspace-a")
    #expect(object?["p"] as? String == "Sources/App.swift")
    #expect((object?["r"] as? [String: Any])?["d"] as? String == "sha256:before")
    #expect(object?["x"] as? String == "print(\"hello\")\n")
}

@Test func workspaceFileRequestsKeepDistinctIDsForConcurrentOperations() throws {
    let first = WorkspaceFileRequest.read(
        requestID: WorkspaceFileRequestID(value: "read-1"),
        workspaceID: "workspace-a",
        path: "Sources/App.swift"
    )
    let second = WorkspaceFileRequest.read(
        requestID: WorkspaceFileRequestID(value: "read-2"),
        workspaceID: "workspace-a",
        path: "Sources/App.swift"
    )

    #expect(first != second)
    let firstObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(first)) as? [String: Any]
    let secondObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(second)) as? [String: Any]
    #expect(firstObject?["rid"] as? String == "read-1")
    #expect(secondObject?["rid"] as? String == "read-2")
}

@Test func workspaceFileResponsesRoundTripWithCompactKeys() throws {
    let revision = WorkspaceFileRevision(digest: "sha256:current")
    let workspace = WorkspaceSummary(id: "workspace-a", name: "AgentDesk")
    let requestIDs = [
        WorkspaceFileRequestID(value: "request-workspaces"),
        WorkspaceFileRequestID(value: "request-directory"),
        WorkspaceFileRequestID(value: "request-read"),
        WorkspaceFileRequestID(value: "request-write"),
        WorkspaceFileRequestID(value: "request-conflict"),
        WorkspaceFileRequestID(value: "request-error"),
    ]
    let entry = WorkspaceDirectoryEntry(
        name: "Sources",
        path: "Sources",
        isDirectory: true
    )
    let values: [WorkspaceFileResponse] = [
        .workspaces(requestID: requestIDs[0], result: WorkspaceListResult(workspaces: [workspace])),
        .directory(requestID: requestIDs[1], result: WorkspaceDirectoryListResult(
            workspaceID: "workspace-a", path: "", entries: [entry]
        )),
        .read(requestID: requestIDs[2], result: WorkspaceFileReadResult(
            workspaceID: "workspace-a", path: "Sources/App.swift", text: "print(\"hello\")\n", revision: revision
        )),
        .write(requestID: requestIDs[3], result: WorkspaceFileWriteResult(
            workspaceID: "workspace-a", path: "Sources/App.swift", revision: revision
        )),
        .conflict(requestID: requestIDs[4], conflict: WorkspaceFileConflict(
            workspaceID: "workspace-a", path: "Sources/App.swift", currentRevision: revision
        )),
        .error(requestID: requestIDs[5], error: WorkspaceFileError(
            code: .tooLarge,
            workspaceID: "workspace-a",
            path: "Sources/App.swift",
            message: "File exceeds the supported size."
        )),
    ]

    for value in values {
        try roundTrip(value)
    }

    let object = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(values[4])
    ) as? [String: Any]
    #expect(object?["t"] as? String == "files-conflict")
    #expect(object?["rid"] as? String == "request-conflict")
    #expect(object?["w"] as? String == "workspace-a")
    #expect(object?["p"] as? String == "Sources/App.swift")
    #expect((object?["r"] as? [String: Any])?["d"] as? String == "sha256:current")
}

@Test func workspaceFileErrorCodesRoundTrip() throws {
    for code in WorkspaceFileErrorCode.allCases {
        try roundTrip(WorkspaceFileResponse.error(
            requestID: WorkspaceFileRequestID(value: "error-\(code.rawValue)"),
            error: WorkspaceFileError(
                code: code,
                workspaceID: "workspace-a",
                path: "Sources/App.swift"
            )
        ))
    }
}

@Test func workspaceFileErrorMessageRoundTripsWhenPresentAndAbsent() throws {
    let requestID = WorkspaceFileRequestID(value: "error-message")
    let present = WorkspaceFileResponse.error(
        requestID: requestID,
        error: WorkspaceFileError(code: .forbidden, message: "This workspace is unavailable.")
    )
    let absent = WorkspaceFileResponse.error(
        requestID: requestID,
        error: WorkspaceFileError(code: .notFound)
    )

    try roundTrip(present)
    try roundTrip(absent)

    let presentObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(present)) as? [String: Any]
    let absentObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(absent)) as? [String: Any]
    #expect(presentObject?["m"] as? String == "This workspace is unavailable.")
    #expect(absentObject?["m"] == nil)
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
    try roundTrip(NormalizedInput.systemCommand(.missionControl))
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
