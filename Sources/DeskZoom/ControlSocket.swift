import Foundation

/// A Unix socket that takes one line of text and answers with one line.
///
/// Deliberately the plainest thing that a shell can drive:
///
///     echo "move 1200 800" | nc -U /tmp/deskzoom.sock
///
/// A connection carries one command and is closed, so there is no session state to get wrong, and a
/// script that dies mid-command leaves nothing behind.
final class ControlSocket {
    private let path: String
    private let handle: (String) -> String
    private var listener: CInt = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "deskzoom.control")

    /// `handle` is called on the main thread and returns the reply line.
    init(path: String, handle: @escaping (String) -> String) {
        self.path = path
        self.handle = handle
    }

    deinit {
        source?.cancel()
        if listener >= 0 { close(listener) }
        unlink(path)
    }

    func start() throws {
        // A socket file outlives the process that made it, including one that crashed, and binding onto a
        // stale one fails. The path is ours, so clearing it is the correct move rather than a workaround.
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DeskZoomError.controlSocketFailed(path, errno) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            throw DeskZoomError.controlSocketFailed(path, ENAMETOOLONG)
        }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            bytes.withUnsafeBytes { destination.copyMemory(from: $0) }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0, listen(fd, 8) == 0 else {
            let failure = errno
            close(fd)
            throw DeskZoomError.controlSocketFailed(path, failure)
        }

        listener = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.resume()
        self.source = source
    }

    private func acceptOne() {
        let client = accept(listener, nil, nil)
        guard client >= 0 else { return }
        defer { close(client) }

        var buffer = [UInt8](repeating: 0, count: 1024)
        let count = read(client, &buffer, buffer.count)
        guard count > 0, let text = String(bytes: buffer[0..<count], encoding: .utf8) else { return }

        var reply = ""
        for line in text.split(whereSeparator: \.isNewline) {
            let command = String(line)
            reply += DispatchQueue.main.sync { self.handle(command) } + "\n"
        }
        _ = reply.withCString { write(client, $0, strlen($0)) }
    }
}
