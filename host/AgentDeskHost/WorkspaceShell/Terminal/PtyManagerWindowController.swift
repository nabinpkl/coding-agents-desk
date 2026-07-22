import AppKit
import PtyClientSwift
import TerminalEmulator
import os

/// The embedded PTY Manager (ADR-0054, Phase H / R56): a host-owned window listing the pty-manager
/// daemon's live sessions and their attached clients, with close/kill/attach controls. It replaces the
/// donor's separate `pty-manager-ui` sidecar *process* with an in-host `NSOutlineView` window driven
/// directly by our own `PtyClient` (`PtyManagerSocketClient`), so a menubar app ships no second binary.
/// Sessions are top-level rows (Name/PID/Clients/CWD/Shell/State); each client is a child row. Opened
/// from the shell top-bar "PTY Manager" chip.
@MainActor
final class PtyManagerWindowController: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSWindowDelegate {
    /// One outline row: a session, or a client under it. Reference type because NSOutlineView needs
    /// stable item identity for view-based rows and expansion state.
    private final class Node {
        let session: PtySessionSummary
        let client: PtySessionClientSummary?
        var children: [Node] = []
        init(session: PtySessionSummary, client: PtySessionClientSummary? = nil) {
            self.session = session
            self.client = client
        }
        var isSession: Bool { client == nil }
    }

    private enum Column: String, CaseIterable {
        case name, pid, clients, cwd, shell, state, action
        var title: String {
            switch self {
            case .name: "Name"
            case .pid: "PID"
            case .clients: "Clients"
            case .cwd: "CWD"
            case .shell: "Shell"
            case .state: "State"
            case .action: ""
            }
        }
        var width: CGFloat {
            switch self {
            case .name: 190
            case .pid: 70
            case .clients: 64
            case .cwd: 300
            case .shell: 150
            case .state: 90
            case .action: 260
            }
        }
    }

    private let window: NSWindow
    private let outlineView = NSOutlineView()
    private let statusLabel = NSTextField(labelWithString: "Disconnected")
    private let client: PtyClient
    private let terminalSpawn: WebPtyManagerTerminalSpawn
    private let socketPath: String
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let terminalWindowRegistry: TerminalWindowRegistry
    private var nodes: [Node] = []
    private var subscription: Task<Void, Never>?

    init(terminalWindowRegistry: TerminalWindowRegistry) {
        self.terminalWindowRegistry = terminalWindowRegistry
        socketPath = PtyManagerSocketClient.socketPath
        client = PtyManagerSocketClient.makeClient()
        terminalSpawn = WebPtyManagerTerminalSpawn(client: PtyManagerSocketClient.makeClient())
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )
        super.init()
        window.title = "PTY Manager"
        window.isReleasedWhenClosed = false
        window.center()
        window.setAccessibilityIdentifier("pty-manager-window")
        window.delegate = self
        buildChrome()
    }

    /// Brings the window forward, (re)subscribing to the session stream if it isn't already live.
    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if subscription == nil { reconnect() }
    }

    // MARK: - Chrome

    private func buildChrome() {
        let reconnectButton = NSButton(title: "Reconnect", target: self, action: #selector(reconnectTapped))
        reconnectButton.setAccessibilityIdentifier("pty-manager-reconnect")
        let header = NSStackView(views: [
            NSTextField(labelWithString: "PTY Sessions"),
            NSView(),
            reconnectButton,
        ])
        header.orientation = .horizontal
        header.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        header.translatesAutoresizingMaskIntoConstraints = false

        for column in Column.allCases {
            let tableColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.rawValue))
            tableColumn.title = column.title
            tableColumn.width = column.width
            outlineView.addTableColumn(tableColumn)
        }
        outlineView.outlineTableColumn = outlineView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(Column.name.rawValue))
        outlineView.dataSource = self
        outlineView.delegate = self
        outlineView.usesAlternatingRowBackgroundColors = true
        outlineView.setAccessibilityIdentifier("pty-manager-outline")

        let scroll = NSScrollView()
        scroll.documentView = outlineView
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        let footer = NSView()
        footer.translatesAutoresizingMaskIntoConstraints = false
        footer.addSubview(statusLabel)

        let content = NSView()
        content.addSubview(header)
        content.addSubview(scroll)
        content.addSubview(footer)
        window.contentView = content
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: content.topAnchor),
            header.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            footer.topAnchor.constraint(equalTo: scroll.bottomAnchor),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: 28),
            statusLabel.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 12),
            statusLabel.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
        ])
    }

    // MARK: - Subscription

    @objc private func reconnectTapped() { reconnect() }

    private func reconnect() {
        subscription?.cancel()
        statusLabel.stringValue = "Connecting to \(socketPath)"
        subscription = Task { [weak self] in
            guard let self else { return }
            do {
                for try await snapshot in self.client.sessionSnapshots() {
                    if Task.isCancelled { return }
                    self.render(snapshot, status: "Connected to \(self.socketPath)")
                }
                // A cancelled consumer ends the stream normally (not via the catch), so this
                // fallback must also bail on cancellation — otherwise a Reconnect that supersedes
                // this task would let the old task stomp the new subscription's status back to
                // "Disconnected".
                if Task.isCancelled { return }
                self.render(self.currentSessions(), status: "Disconnected")
            } catch {
                if Task.isCancelled { return }
                self.render(self.currentSessions(), status: "Error: \(error)")
            }
        }
    }

    private func currentSessions() -> [PtySessionSummary] { nodes.map(\.session) }

    private func render(_ sessions: [PtySessionSummary], status: String) {
        nodes = sessions.map { session in
            let node = Node(session: session)
            node.children = session.clients.map { Node(session: session, client: $0) }
            return node
        }
        statusLabel.stringValue = status
        outlineView.reloadData()
        for node in nodes { outlineView.expandItem(node) }
    }

    func stop() {
        subscription?.cancel()
        subscription = nil
        window.orderOut(nil)
    }

    /// Closing the window (the OS "×") only hides it (isReleasedWhenClosed=false), so tear the
    /// session stream and its socket connection down here; a later show() re-subscribes because
    /// `subscription` is nil again.
    func windowWillClose(_ notification: Notification) {
        subscription?.cancel()
        subscription = nil
    }

    // MARK: - NSOutlineViewDataSource

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        guard let node = item as? Node else { return nodes.count }
        return node.children.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        guard let node = item as? Node else { return nodes[index] }
        return node.children[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? Node)?.children.isEmpty == false
    }

    // MARK: - NSOutlineViewDelegate

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? Node, let tableColumn,
              let column = Column(rawValue: tableColumn.identifier.rawValue) else { return nil }
        if column == .action { return actionView(for: node) }
        return textCell(text(for: node, column: column))
    }

    private func text(for node: Node, column: Column) -> String {
        if let client = node.client {
            // Client rows carry identity in the name column; other columns stay blank.
            return column == .name ? "client \(client.id) — \(client.title)" : ""
        }
        let session = node.session
        switch column {
        case .name: return session.name
        case .pid: return String(session.pid)
        case .clients: return String(session.clientCount)
        case .cwd: return session.cwd
        case .shell: return session.shell
        case .state: return stateText(session.state)
        case .action: return ""
        }
    }

    private func stateText(_ state: PtySessionSummary.State) -> String {
        switch state {
        case .running: "running"
        case .exited: "exited"
        default: "unknown"
        }
    }

    private func textCell(_ string: String) -> NSTableCellView {
        let cell = NSTableCellView()
        let field = NSTextField(labelWithString: string)
        field.lineBreakMode = .byTruncatingTail
        field.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(field)
        cell.textField = field
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    private func actionView(for node: Node) -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 6
        if node.isSession {
            stack.addArrangedSubview(makeButton("Open Client", #selector(openClientTapped)))
            stack.addArrangedSubview(makeButton("Close Session", #selector(closeSessionTapped)))
        } else {
            stack.addArrangedSubview(makeButton("Close", #selector(closeClientTapped)))
        }
        return stack
    }

    private func makeButton(_ title: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.controlSize = .small
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 11)
        return button
    }

    private func node(forSender sender: NSView) -> Node? {
        let row = outlineView.row(for: sender)
        guard row >= 0 else { return nil }
        return outlineView.item(atRow: row) as? Node
    }

    // MARK: - Actions

    @objc private func openClientTapped(_ sender: NSButton) {
        guard let node = node(forSender: sender), node.isSession else { return }
        let session = node.session
        terminalSpawn.spawnExistingSession(session, into: Self.attachFrame()) { [weak self] result in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch result {
                case .success(let window):
                    self.terminalWindowRegistry.register(
                        window,
                        sessionName: session.name,
                        workspaceID: nil,
                        workspaceLabel: session.name,
                        cascadeOrdinal: 0
                    )
                    window.raise()
                    self.statusLabel.stringValue = "Opened a client for \(session.name)"
                case .failure(let error):
                    self.statusLabel.stringValue = "Open client failed: \(error)"
                }
            }
        }
    }

    @objc private func closeSessionTapped(_ sender: NSButton) {
        guard let node = node(forSender: sender), node.isSession else { return }
        let name = node.session.name
        guard confirm(title: "Close session \(name)?", info: "This kills the session and its shell process.") else { return }
        // Detached + a locally-created client so the request runs off the main actor without sending
        // the actor-isolated client across the boundary; only the status update hops back to the UI.
        Task.detached { [weak self] in
            do { try await PtyManagerSocketClient.makeClient().killSession(name: name) }
            catch { await MainActor.run { self?.statusLabel.stringValue = "Close session failed: \(error)" } }
        }
    }

    @objc private func closeClientTapped(_ sender: NSButton) {
        guard let node = node(forSender: sender), let client = node.client else { return }
        let sessionName = node.session.name
        let clientID = client.id
        Task.detached { [weak self] in
            do { try await PtyManagerSocketClient.makeClient().closeClient(sessionName: sessionName, clientID: clientID) }
            catch { await MainActor.run { self?.statusLabel.stringValue = "Close client failed: \(error)" } }
        }
    }

    private func confirm(title: String, info: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = info
        alert.addButton(withTitle: "Close")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private static func attachFrame() -> CGRect {
        let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: 720, height: 460)
        return CGRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
    }
}
