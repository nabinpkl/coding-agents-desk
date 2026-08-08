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

@Test func domBatchEnvelopeRoundTripsWithoutLegacyEmulationState() throws {
    try roundTrip(DomBatchEnvelope(tabId: 7, checkout: false))
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

@Test func wireProtocolLiveAgentVersionIsPinned() {
    #expect(WireProtocol.version == 17)
    #expect(WireProtocol.minCompatibleVersion == 17)
}

@Test func quicSessionAgentRoleIsPinnedAndRoundTrips() throws {
    #expect(QuicSessionStreamRole.agent.rawValue == 9)
    #expect(QuicSessionStreamRole(rawValue: 9) == .agent)

    let payload = Data(#"{"t":"agent-live-tail","src":"claude","sid":"s","ev":null}"#.utf8)
    let encoded = try QuicSessionStreamFrame.encode(role: .agent, payload: payload)
    let decoded = try QuicSessionStreamFrame.decode(encoded)

    #expect(decoded.role == .agent)
    #expect(decoded.payload == payload)
}

@Test func liveAgentCommandsTimelineAndExtensionUIRoundTrip() throws {
    try roundTrip(AgentSessionCreate(
        requestId: "create-1",
        source: "pi",
        projectPath: "/project"
    ))
    try roundTrip(AgentSessionSend(
        requestId: "send-1",
        source: "pi",
        sessionId: "session",
        text: "hello",
        delivery: "steer"
    ))
    try roundTrip(AgentSessionAbort(
        requestId: "abort-1",
        source: "pi",
        sessionId: "session"
    ))
    try roundTrip(AgentCommandReceipt(
        requestId: "create-1",
        source: "pi",
        sessionId: "session",
        delivery: "created",
        session: AgentSessionSummary(
            sessionId: "session",
            source: "pi",
            title: "New session",
            lastEventAt: 10,
            activity: "ready",
            capabilities: AgentSessionCapabilities(
                modes: ["nice"],
                canSend: true,
                canSteer: true,
                canAbort: true,
                canFetchRaw: false,
                canOpenTerminal: false,
                supportsExtensionUI: true
            )
        )
    ))
    try roundTrip(AgentCommandError(
        requestId: "send-1",
        code: "request-conflict",
        message: "request id was reused",
        retryable: false
    ))
    try roundTrip(AgentThreadChunk(
        source: "pi",
        sessionId: "session",
        events: [ActivityEvent(
            id: "assistant-1",
            index: 0,
            revision: 2,
            phase: "streaming",
            ts: 1,
            type: "assistant",
            blocks: [ActivityBlock(kind: "text", text: "hel")]
        )],
        windowStart: 0,
        total: 1,
        isLive: true,
        mode: "nice",
        kind: "upsert",
        sequence: 4,
        runState: "running",
        queueSteer: 1,
        queueFollowUp: 2
    ))
    try roundTrip(AgentExtensionUIRequest(
        source: "pi",
        sessionId: "session",
        requestId: "ui-1",
        kind: "select",
        title: "Choose",
        options: ["one", "two"],
        expectsResponse: true
    ))
    try roundTrip(AgentExtensionUIResponse(
        source: "pi",
        sessionId: "session",
        requestId: "ui-1",
        value: .object(["choice": .string("two")])
    ))
    try roundTrip(AgentExtensionUIDismissed(
        source: "pi",
        sessionId: "session",
        requestId: "ui-1"
    ))
}

@Test func clientScreenshotContractsRoundTrip() throws {
    let request = ClientScreenshotRequest(
        requestId: "capture-1",
        maxPixelDimension: 2_048,
        maxBytes: 4 * 1_024 * 1_024
    )
    let manifest = ClientScreenshotManifest(
        requestId: request.requestId,
        capturedAt: 1_800_000_000,
        clientBuildSHA: "abc1234",
        surfaceName: "terminal",
        pixelWidth: 1_179,
        pixelHeight: 2_556,
        scale: 3,
        orientation: "portrait",
        mimeType: "image/jpeg",
        totalBytes: 123_456,
        sha256: String(repeating: "a", count: 64),
        omittedLayers: ["system-keyboard"]
    )
    let chunk = ClientScreenshotChunk(
        requestId: request.requestId,
        sequence: 0,
        isFinal: true,
        payloadBase64: Data([1, 2, 3]).base64EncodedString()
    )
    let error = ClientScreenshotError(requestId: request.requestId, reason: "not-authorized")
    let signed = SignedClientScreenshotRequest(
        requestId: request.requestId,
        maxPixelDimension: request.maxPixelDimension,
        maxBytes: request.maxBytes,
        hostFingerprint: "host-fingerprint",
        issuedAt: 1_800_000_000,
        nonce: Data(repeating: 7, count: 32),
        hostSignature: Data(repeating: 8, count: 64)
    )

    try roundTrip(request)
    try roundTrip(manifest)
    try roundTrip(chunk)
    try roundTrip(error)
    try roundTrip(signed)
    #expect(signed.request == request)
}

@Test func screenshotSignatureCoversRequestBounds() throws {
    let nonce = Data(repeating: 9, count: 32)
    let first = try ClientScreenshotRequestSignature.signingData(
        request: ClientScreenshotRequest(requestId: "capture", maxPixelDimension: 2_048, maxBytes: 4_000_000),
        hostFingerprint: "host",
        issuedAt: 123,
        nonce: nonce
    )
    let changed = try ClientScreenshotRequestSignature.signingData(
        request: ClientScreenshotRequest(requestId: "capture", maxPixelDimension: 1_024, maxBytes: 4_000_000),
        hostFingerprint: "host",
        issuedAt: 123,
        nonce: nonce
    )
    #expect(first != changed)
}

@Test func screenshotFallbackChunkFitsOfferPortFrame() throws {
    let chunk = ClientScreenshotChunk(
        requestId: UUID().uuidString.lowercased(),
        sequence: 0,
        isFinal: true,
        payloadBase64: Data(repeating: 0xA5, count: 32 * 1_024).base64EncodedString()
    )
    let body = try JSONEncoder().encode(chunk)

    #expect(body.count <= OfferPortFrame.maxPayloadByteCount)
    let framed = try OfferPortFrame.encode(body)
    #expect(framed.count == body.count + OfferPortFrame.fixedHeaderByteCount)
}

@Test func workspaceTerminalMessagesRoundTripWithoutHostPathOrLaunchAuthority() throws {
    let requestID = "workspace-request-1"
    let workspaceID = "62193559-6f63-4b24-a53e-ea2f23c39d4a"
    let sessionName = "workspace-62193559-6f63-4b24-a53e-ea2f23c39d4a-a1b2c3d4e5f6"
    let clientMessages: [WorkspaceTerminalClientMessage] = [
        .open(WorkspaceTerminalOpen(
            requestID: requestID,
            workspaceID: workspaceID,
            preferredSessionName: sessionName,
            columns: 120,
            rows: 40
        )),
        .attached(WorkspaceTerminalAttachedAck(
            requestID: requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName
        )),
        .cancel(WorkspaceTerminalCancel(
            requestID: requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName
        )),
    ]
    let hostMessages: [WorkspaceTerminalHostMessage] = [
        .ready(WorkspaceTerminalReady(
            requestID: requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName
        )),
        .error(WorkspaceTerminalError(
            requestID: requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName,
            code: .handoffTimedOut
        )),
    ]

    for message in clientMessages { try roundTrip(message) }
    for message in hostMessages { try roundTrip(message) }

    let encoded = try clientMessages.map { try JSONEncoder().encode($0) }
    let tags = try encoded.map {
        (try JSONSerialization.jsonObject(with: $0) as? [String: Any])?["t"] as? String
    }
    #expect(tags == [
        "workspace-terminal-open",
        "workspace-terminal-attached",
        "workspace-terminal-cancel",
    ])
    for data in encoded {
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["rid"] as? String == requestID)
        #expect(object["wid"] as? String == workspaceID)
        let json = String(decoding: data, as: UTF8.self)
        #expect(!json.contains("/Users/"))
        #expect(!json.contains("cwd"))
        #expect(!json.contains("shell"))
        #expect(!json.contains("executable"))
        #expect(!json.contains("arguments"))
    }
}

@Test func workspaceTerminalErrorCodesAreExhaustiveAndStable() throws {
    #expect(WorkspaceTerminalErrorCode.allCases.map(\.rawValue) == [
        "workspaceUnavailable",
        "invalidSession",
        "launchFailed",
        "handoffTimedOut",
        "sessionEnded",
    ])
    for code in WorkspaceTerminalErrorCode.allCases { try roundTrip(code) }
}

@Test func cursorInputRequiresAndPreservesRevision() throws {
    let frame = InputChannelEvent(
        event: .cursorMove(dx: 4.5, dy: -2.25),
        cursorRevision: 17
    )
    try roundTrip(frame)

    let missingRevision = Data(#"{"t":"input-event","ev":{"cursorMove":{"dx":4.5,"dy":-2.25}}}"#.utf8)
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(InputChannelEvent.self, from: missingRevision)
    }
}

@Test func nonCursorInputRejectsCursorRevision() throws {
    let invalid = InputChannelEvent(
        event: .click(button: .left),
        cursorRevision: 3
    )
    #expect(throws: EncodingError.self) {
        try JSONEncoder().encode(invalid)
    }
}

@Test func cursorFeedbackSeparatesAppliedAndHostMovedProvenance() throws {
    try roundTrip(CursorAppliedPush(
        cursorRevision: 23,
        displayId: "display-a",
        cursorX: 410,
        cursorY: 215
    ))
    try roundTrip(HostCursorMovedPush(
        afterCursorRevision: 23,
        displayId: "display-a",
        cursorX: 900,
        cursorY: 600
    ))
}

@Test func workspaceFilesCodecCarriesDocumentBytesWithoutJSONBase64() throws {
    let bytes = Data([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    let response = WorkspaceLaneResponse.files(.read(
        requestID: WorkspaceRequestID(value: "docx"),
        result: WorkspaceFileReadResult(
            workspaceID: "workspace-a",
            path: "Report.docx",
            content: .document(bytes),
            revision: WorkspaceFileRevision(digest: "sha256:docx")
        )
    ))

    let encoded = try WorkspaceLaneCodec.encode(response)
    #expect(encoded.starts(with: Data("bplist".utf8)))
    guard case .files(.read(_, let decoded)) = try WorkspaceLaneCodec.decodeResponse(encoded) else {
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
        WorkspaceRequestID(value: "request-workspaces"),
        WorkspaceRequestID(value: "request-directory"),
        WorkspaceRequestID(value: "request-read"),
        WorkspaceRequestID(value: "request-write"),
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
        requestID: WorkspaceRequestID(value: "read-1"),
        workspaceID: "workspace-a",
        path: "Sources/App.swift"
    )
    let second = WorkspaceFileRequest.read(
        requestID: WorkspaceRequestID(value: "read-2"),
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
    let workspace = WorkspaceSummary(
        id: "workspace-a",
        name: "AgentDesk",
        desktopOrdinal: 2,
        desktopAutoAssignEnabled: true
    )
    let requestIDs = [
        WorkspaceRequestID(value: "request-workspaces"),
        WorkspaceRequestID(value: "request-directory"),
        WorkspaceRequestID(value: "request-read"),
        WorkspaceRequestID(value: "request-write"),
        WorkspaceRequestID(value: "request-conflict"),
        WorkspaceRequestID(value: "request-error"),
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
            requestID: WorkspaceRequestID(value: "error-\(code.rawValue)"),
            error: WorkspaceFileError(
                code: code,
                workspaceID: "workspace-a",
                path: "Sources/App.swift"
            )
        ))
    }
}

@Test func workspaceFileErrorMessageRoundTripsWhenPresentAndAbsent() throws {
    let requestID = WorkspaceRequestID(value: "error-message")
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
        autoKeyboardEnabled: false,
        diagnosticScreenshotsEnabled: true
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
    #expect(object?["ds"] as? Bool == true)
}

@Test func clientConfigDefaultsAutoKeyboardEnabledWhenMissing() throws {
    let data = Data(#"{"t":"client-config","te":false}"#.utf8)
    let decoded = try JSONDecoder().decode(ClientConfig.self, from: data)
    #expect(decoded.autoKeyboardEnabled)
    #expect(decoded.diagnosticScreenshotsEnabled == false)
}

@Test func clientConfigCarriesSelectedWindowAlongsideDisplay() throws {
    // The window target is additive: the display still owns the input coordinate space
    // and DesktopState, so both ride the same config rather than one replacing the other.
    let config = ClientConfig(
        thumbnailsEnabled: true,
        selectedDisplayId: "display-1",
        selectedWindowId: 32_517
    )
    try roundTrip(config)

    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(config)
    ) as? [String: Any]
    #expect(object?["sd"] as? String == "display-1")
    #expect(object?["sw"] as? UInt32 == 32_517)
}

@Test func clientConfigOmitsSelectedWindowWhenWatchingADisplay() throws {
    // Absent means display capture. A peer that never sends the key must not read as
    // "window 0", which would be a target the host cannot resolve.
    let config = ClientConfig(thumbnailsEnabled: false, selectedDisplayId: "display-1")
    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(config)
    ) as? [String: Any]
    #expect(object?["sw"] == nil)

    let decoded = try JSONDecoder().decode(
        ClientConfig.self,
        from: Data(#"{"t":"client-config","te":false}"#.utf8)
    )
    #expect(decoded.selectedWindowId == nil)
}

@Test func clientConfigCarriesTheVideoViewportInPixels() throws {
    // Pixels, not points: the host sizes a watched window so one captured pixel lands on one
    // phone pixel, and the two devices have different scale factors.
    let config = ClientConfig(
        thumbnailsEnabled: true,
        selectedWindowId: 32_517,
        videoViewport: ClientVideoViewport(widthPixels: 1206, heightPixels: 1443)
    )
    try roundTrip(config)

    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(config)
    ) as? [String: Any]
    let viewport = object?["vp"] as? [String: Any]
    #expect(viewport?["w"] as? UInt32 == 1206)
    #expect(viewport?["h"] as? UInt32 == 1443)
}

@Test func clientConfigWithoutAViewportAsksForNoFit() throws {
    // Absent means the client is not asking for a fit, which must leave the window's geometry
    // alone rather than decode as a zero-sized viewport the host would act on.
    let decoded = try JSONDecoder().decode(
        ClientConfig.self,
        from: Data(#"{"t":"client-config","te":false,"sw":42}"#.utf8)
    )
    #expect(decoded.videoViewport == nil)

    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(ClientConfig(thumbnailsEnabled: false))
    ) as? [String: Any]
    #expect(object?["vp"] == nil)
}

@Test func voiceAssetRequestsRoundTrip() throws {
    try roundTrip(VoiceAssetLaneRequest.manifest)
    try roundTrip(VoiceAssetLaneRequest.fetch(path: "VoicePhoneModel.mlmodelc/model.mil", offset: 0))
    // Resume is the point of the offset: restarting a 152MB asset because a
    // session blipped turns a pause into a failure.
    try roundTrip(VoiceAssetLaneRequest.fetch(path: "VoicePhoneModel.mlmodelc/weights/weight.bin", offset: 104_857_600))

    let data = Data(#"{"t":"fetch","p":"VoiceZIPAModel.onnx"}"#.utf8)
    let decoded = try JSONDecoder().decode(VoiceAssetLaneRequest.self, from: data)
    #expect(decoded == .fetch(path: "VoiceZIPAModel.onnx", offset: 0))
}

@Test func voiceAssetResponsesRoundTrip() throws {
    let descriptor = VoiceAssetDescriptor(
        path: "VoicePhoneModel.mlmodelc/weights/weight.bin",
        byteCount: 159_383_552,
        sha256: String(repeating: "a", count: 64)
    )
    try roundTrip(VoiceAssetLaneResponse.manifest(VoiceAssetManifest(assets: [descriptor])))
    try roundTrip(VoiceAssetLaneResponse.chunk(
        path: "VoicePhoneModel.mlmodelc/model.mil",
        offset: 524_288,
        bytes: Data([0x01, 0x02, 0x03]),
        isLast: false
    ))
    try roundTrip(VoiceAssetLaneResponse.failure(path: "VoiceZIPAModel.onnx", message: "missing"))

    let object = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(VoiceAssetLaneResponse.chunk(
            path: "VoiceZIPAModel.onnx", offset: 0, bytes: Data(), isLast: true
        ))
    ) as? [String: Any]
    #expect(object?["t"] as? String == "chunk")
    #expect(object?["l"] as? Bool == true)
}

@Test func voiceAssetChunksFitTheLaneFrame() throws {
    // A chunk plus its base64 expansion and envelope has to fit the frame the
    // lane will actually encode it into, or every transfer fails at the ceiling.
    let encoded = try JSONEncoder().encode(VoiceAssetLaneResponse.chunk(
        path: "VoicePhoneModel.mlmodelc/weights/weight.bin",
        offset: 0,
        bytes: Data(repeating: 0xab, count: VoiceAssetCodec.chunkBytes),
        isLast: false
    ))
    #expect(encoded.count <= QuicSessionStreamFrame.maxFrameLength(for: .assets))
}

@Test func mediaViewerStateRoundTripsBothDirections() throws {
    try roundTrip(MediaViewerState(isWatchingVideo: true))
    try roundTrip(MediaViewerState(isWatchingVideo: false))

    let data = try JSONEncoder().encode(MediaViewerState(isWatchingVideo: false))
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(object?["t"] as? String == "media-viewer")
    #expect(object?["w"] as? Bool == false)
}

@Test func mediaViewerStateFromAPeerThatOmitsTheTypeTagStillDecodes() throws {
    let data = Data(#"{"w":true}"#.utf8)
    let decoded = try JSONDecoder().decode(MediaViewerState.self, from: data)
    #expect(decoded.isWatchingVideo)
    #expect(decoded.type == "media-viewer")
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

@Test func clientRuntimeCheckpointRoundTripsBoundedPresentationState() throws {
    let checkpoint = ClientRuntimeCheckpoint(
        clientRunId: "run-1",
        sequence: 7,
        timestamp: 1_800_000_000,
        marketingVersion: "1.11.0",
        buildNumber: "900",
        gitSHA: "abc1234",
        scenePhase: .foreground,
        pairingState: .connected,
        activeSurface: .terminal,
        railConfigured: true,
        railHidden: false,
        railLayoutReady: true,
        hostSurfaceCount: 5,
        mediaState: .started,
        videoMilestone: .presentationAttempted
    )

    try roundTrip(checkpoint)
    let encoded = try JSONEncoder().encode(checkpoint)
    #expect(encoded.count <= 512)
    let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    #expect(object?["t"] as? String == "client-runtime-checkpoint")
    #expect(object?["vm"] as? String == "presentation-attempted")
    #expect(object?["rl"] as? Bool == true)
    #expect(object?["hc"] as? Int == 5)
    #expect(Set(object?.keys.map { $0 } ?? []) == [
        "t", "v", "rid", "s", "ts", "mv", "bn", "sha",
        "sp", "ps", "as", "rc", "rh", "rl", "hc", "ms", "vm"
    ])
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
