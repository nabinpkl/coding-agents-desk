import XCTest
@testable import PtyClientSwift

final class PtyClientTests: XCTestCase {
    func testListSessionsMapsSessionSummaries() async throws {
        let transport = MockPtyTransport()
        let response = Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.payload = .sessionList(.with {
                $0.sessions = [.with {
                    $0.name = "main"
                    $0.cwd = "/tmp/work"
                    $0.shell = "/bin/zsh"
                    $0.pid = 42
                    $0.state = .running
                    $0.startedAtUnixMilliseconds = 1_721_344_000_123
                    $0.columns = 80
                    $0.rows = 24
                    $0.revision = 1
                    $0.clients = [
                        .with {
                            $0.id = 10
                            $0.title = "first"
                        },
                        .with {
                            $0.id = 11
                            $0.title = "second"
                        },
                    ]
                }]
            })
        }
        transport.receivedFrames = [try response.serializedData()]

        let sessions = try await PtyClient(transport: transport).listSessions()

        XCTAssertEqual(sessions, [
            PtySessionSummary(
                name: "main",
                cwd: "/tmp/work",
                shell: "/bin/zsh",
                pid: 42,
                state: .running,
                startedAtUnixMilliseconds: 1_721_344_000_123,
                clients: [
                    PtySessionClientSummary(id: 10, title: "first"),
                    PtySessionClientSummary(id: 11, title: "second"),
                ]
            )
        ])
    }

    func testSessionSnapshotsYieldsSnapshotFrames() async throws {
        let transport = MockPtyTransport()
        let response = Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.payload = .sessionSnapshot(.with {
                $0.sessions = [.with {
                    $0.name = "main"
                    $0.cwd = "/tmp/work"
                    $0.shell = "/bin/zsh"
                    $0.pid = 42
                    $0.state = .running
                }]
            })
        }
        transport.receivedFrames = [try response.serializedData()]

        var iterator = PtyClient(transport: transport).sessionSnapshots().makeAsyncIterator()
        let snapshot = try await iterator.next()

        XCTAssertEqual(snapshot?.map(\.name), ["main"])
    }

    func testOpenSessionMapsAttachmentAndSendsCreateOrAttach() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [try Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.sessionName = "main"
            $0.payload = .attached(.with {
                $0.pid = 42
                $0.cwd = "/tmp/work"
                $0.shell = "/bin/zsh"
                $0.clientCount = 1
                $0.clientID = 77
                $0.columns = 80
                $0.rows = 24
                $0.revision = 1
            })
        }.serializedData()]

        let connection = try await PtyClient(transport: transport).openSession(
            name: "main",
            launch: .shell(cwd: "/tmp/work", shell: "/bin/zsh"),
            columns: 120,
            rows: 40,
            createIfMissing: false,
            clientTitle: "Inspector"
        )

        XCTAssertEqual(connection.attachment, PtySessionAttachment(
            name: "main",
            pid: 42,
            cwd: "/tmp/work",
            shell: "/bin/zsh",
            clientCount: 1,
            clientID: 77
        ))
        let sent = try XCTUnwrap(transport.sentEnvelope(at: 0))
        guard case .createOrAttach(let request) = sent.payload else {
            return XCTFail("expected createOrAttach, got \(String(describing: sent.payload))")
        }
        XCTAssertEqual(sent.sessionName, "main")
        guard case .shellLaunch(let shell) = request.launch else {
            return XCTFail("expected shell launch, got \(String(describing: request.launch))")
        }
        XCTAssertEqual(shell.cwd, "/tmp/work")
        XCTAssertEqual(shell.shell, "/bin/zsh")
        XCTAssertEqual(request.columns, 120)
        XCTAssertEqual(request.rows, 40)
        XCTAssertFalse(request.createIfMissing)
        XCTAssertEqual(request.clientTitle, "Inspector")
    }

    func testOpenSessionPreservesCommandArgumentBoundariesAndLeasedLifetime() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [try Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.sessionName = "agent-resume-codex-session"
            $0.payload = .attached(.with {
                $0.pid = 84
                $0.cwd = "/tmp/project with spaces"
                $0.shell = "/usr/local/bin/codex"
                $0.clientCount = 1
                $0.clientID = 78
            })
        }.serializedData()]
        let arguments = ["resume", "id with spaces", "$(not-expanded)", "semi;colon"]

        _ = try await PtyClient(transport: transport).openSession(
            name: "agent-resume-codex-session",
            launch: .command(
                cwd: "/tmp/project with spaces",
                executable: "/usr/local/bin/codex",
                arguments: arguments
            ),
            columns: 100,
            rows: 30,
            createIfMissing: true,
            clientTitle: "Agent Panel"
        )

        let sent = try XCTUnwrap(transport.sentEnvelope(at: 0))
        guard case .createOrAttach(let request) = sent.payload,
              case .commandLaunch(let command) = request.launch else {
            return XCTFail("expected command create or attach")
        }
        XCTAssertEqual(command.cwd, "/tmp/project with spaces")
        XCTAssertEqual(command.executable, "/usr/local/bin/codex")
        XCTAssertEqual(command.arguments, arguments)
    }

    func testSessionConnectionYieldsOutputAndExitEvents() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [
            try Pty_V1_Envelope.with {
                $0.protocolVersion = PtyClient.protocolVersion
                $0.sessionName = "main"
                $0.payload = .output(.with {
                    $0.data = Data("hello".utf8)
                    $0.revision = 2
                })
            }.serializedData(),
            try Pty_V1_Envelope.with {
                $0.protocolVersion = PtyClient.protocolVersion
                $0.sessionName = "main"
                $0.payload = .sessionExited(.with { $0.status = 7 })
            }.serializedData(),
        ]
        let connection = PtySessionConnection(
            sessionName: "main",
            attachment: PtySessionAttachment(
                name: "main",
                pid: 1,
                cwd: "/",
                shell: "/bin/sh",
                clientCount: 1,
                clientID: 10
            ),
            transport: transport
        )

        var iterator = connection.events().makeAsyncIterator()

        let attached = try await iterator.next()
        let output = try await iterator.next()
        let exited = try await iterator.next()
        let finished = try await iterator.next()

        XCTAssertEqual(attached, .attached(connection.attachment))
        XCTAssertEqual(output, .output(data: Data("hello".utf8), revision: 2))
        XCTAssertEqual(exited, .exited(7))
        XCTAssertNil(finished)
    }

    func testSessionConnectionYieldsManagerDetachEvent() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [
            try Pty_V1_Envelope.with {
                $0.protocolVersion = PtyClient.protocolVersion
                $0.sessionName = "main"
                $0.payload = .clientDetached(.with { $0.clientID = 99 })
            }.serializedData(),
        ]
        let connection = PtySessionConnection(
            sessionName: "main",
            attachment: PtySessionAttachment(
                name: "main",
                pid: 1,
                cwd: "/",
                shell: "/bin/sh",
                clientCount: 1,
                clientID: 10
            ),
            transport: transport
        )

        var iterator = connection.events().makeAsyncIterator()

        let attached = try await iterator.next()
        let detached = try await iterator.next()
        let finished = try await iterator.next()

        XCTAssertEqual(attached, .attached(connection.attachment))
        XCTAssertEqual(detached, .detachedByManager(99))
        XCTAssertNil(finished)
    }

    func testSessionConnectionYieldsTargetedViewportStatus() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [
            try Pty_V1_Envelope.with {
                $0.protocolVersion = PtyClient.protocolVersion
                $0.sessionName = "main"
                $0.payload = .terminalViewportStatus(.with {
                    $0.ownershipEpoch = 8
                    $0.ownerClientID = 44
                    $0.ownerTitle = "Mac Terminal"
                    $0.isOwner = false
                    $0.sourceColumns = 130
                    $0.sourceRows = 42
                    $0.sourceRevision = 19
                    $0.viewColumns = 52
                    $0.viewRows = 24
                })
            }.serializedData(),
        ]
        let connection = PtySessionConnection(
            sessionName: "main",
            attachment: PtySessionAttachment(
                name: "main",
                pid: 1,
                cwd: "/",
                shell: "/bin/sh",
                clientCount: 2,
                clientID: 45
            ),
            transport: transport
        )
        var iterator = connection.events().makeAsyncIterator()

        _ = try await iterator.next()
        let event = try await iterator.next()

        XCTAssertEqual(event, .viewportStatus(.init(
            ownershipEpoch: 8,
            ownerClientID: 44,
            ownerTitle: "Mac Terminal",
            isOwner: false,
            sourceDimensions: .init(columns: 130, rows: 42),
            sourceRevision: 19,
            viewDimensions: .init(columns: 52, rows: 24)
        )))
    }

    func testSessionConnectionSendsInputViewerStateDetachAndKill() async throws {
        let transport = MockPtyTransport()
        let connection = PtySessionConnection(
            sessionName: "main",
            attachment: PtySessionAttachment(
                name: "main",
                pid: 1,
                cwd: "/",
                shell: "/bin/sh",
                clientCount: 1,
                clientID: 10
            ),
            transport: transport
        )

        try await connection.sendInput(Data("x".utf8))
        try await connection.updateViewerState(
            sequence: 1,
            active: true,
            claim: true,
            columns: 90,
            rows: 30
        )
        try await connection.kill()
        try await connection.detach()

        let payloads = try transport.sentFrames.map {
            try Pty_V1_Envelope(serializedBytes: $0).payload
        }
        guard case .input(let input) = payloads[0] else {
            return XCTFail("expected input")
        }
        guard case .terminalViewerState(let viewer) = payloads[1] else {
            return XCTFail("expected terminal viewer state")
        }
        guard case .killSession = payloads[2] else {
            return XCTFail("expected kill")
        }
        guard case .detach = payloads[3] else {
            return XCTFail("expected detach")
        }
        XCTAssertEqual(input.data, Data("x".utf8))
        XCTAssertEqual(viewer.sequence, 1)
        XCTAssertTrue(viewer.active)
        XCTAssertTrue(viewer.claim)
        XCTAssertEqual(viewer.columns, 90)
        XCTAssertEqual(viewer.rows, 30)
    }

    func testProtocolVersionSixSurfacesError() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [try Pty_V1_Envelope.with {
            $0.protocolVersion = 6
            $0.payload = .sessionList(.init())
        }.serializedData()]

        do {
            _ = try await PtyClient(transport: transport).listSessions()
            XCTFail("expected invalid protocol version")
        } catch PtyClientError.invalidProtocolVersion(6) {
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testCloseClientSendsCloseClientRequest() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [try Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.sessionName = "main"
            $0.payload = .clientDetached(.with { $0.clientID = 77 })
        }.serializedData()]

        try await PtyClient(transport: transport).closeClient(sessionName: "main", clientID: 77)

        let sent = try XCTUnwrap(transport.sentEnvelope(at: 0))
        guard case .closeClient(let request) = sent.payload else {
            return XCTFail("expected closeClient, got \(String(describing: sent.payload))")
        }
        XCTAssertEqual(sent.sessionName, "main")
        XCTAssertEqual(request.clientID, 77)
    }
}

private final class MockPtyTransport: PtyTransport {
    var sentFrames: [Data] = []
    var receivedFrames: [Data] = []

    func sendFrame(_ data: Data) async throws {
        sentFrames.append(data)
    }

    func receiveFrame() async throws -> Data {
        guard !receivedFrames.isEmpty else { throw PtyClientError.closed }
        return receivedFrames.removeFirst()
    }

    func close() {}

    func sentEnvelope(at index: Int) throws -> Pty_V1_Envelope? {
        guard sentFrames.indices.contains(index) else { return nil }
        return try Pty_V1_Envelope(serializedBytes: sentFrames[index])
    }
}
