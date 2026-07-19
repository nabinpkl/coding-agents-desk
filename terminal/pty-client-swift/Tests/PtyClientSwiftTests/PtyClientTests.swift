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
                    $0.lifetime = .persistent
                    $0.startedAtUnixMilliseconds = 1_721_344_000_123
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
                lifetime: .persistent,
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
                    $0.lifetime = .persistent
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
            })
        }.serializedData()]

        let connection = try await PtyClient(transport: transport).openSession(
            name: "main",
            launch: .shell(cwd: "/tmp/work", shell: "/bin/zsh"),
            lifetime: .persistent,
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
        XCTAssertEqual(request.lifetime, .persistent)
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
            lifetime: .leased,
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
        XCTAssertEqual(request.lifetime, .leased)
    }

    func testSessionConnectionYieldsOutputAndExitEvents() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [
            try Pty_V1_Envelope.with {
                $0.protocolVersion = PtyClient.protocolVersion
                $0.sessionName = "main"
                $0.payload = .output(.with { $0.data = Data("hello".utf8) })
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
        XCTAssertEqual(output, .output(Data("hello".utf8)))
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

    func testSessionConnectionSendsInputResizeDetachAndKill() async throws {
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
        try await connection.resize(columns: 90, rows: 30)
        try await connection.kill()
        try await connection.detach()

        let payloads = try transport.sentFrames.map {
            try Pty_V1_Envelope(serializedBytes: $0).payload
        }
        guard case .input(let input) = payloads[0] else {
            return XCTFail("expected input")
        }
        guard case .resize(let resize) = payloads[1] else {
            return XCTFail("expected resize")
        }
        guard case .killSession = payloads[2] else {
            return XCTFail("expected kill")
        }
        guard case .detach = payloads[3] else {
            return XCTFail("expected detach")
        }
        XCTAssertEqual(input.data, Data("x".utf8))
        XCTAssertEqual(resize.columns, 90)
        XCTAssertEqual(resize.rows, 30)
    }

    func testInvalidProtocolVersionSurfacesError() async throws {
        let transport = MockPtyTransport()
        transport.receivedFrames = [try Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion + 1
            $0.payload = .sessionList(.init())
        }.serializedData()]

        do {
            _ = try await PtyClient(transport: transport).listSessions()
            XCTFail("expected invalid protocol version")
        } catch PtyClientError.invalidProtocolVersion(PtyClient.protocolVersion + 1) {
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
