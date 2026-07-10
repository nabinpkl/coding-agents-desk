import Darwin
import Foundation
import AgentDeskWire

final class WorkspaceFileDescriptor {
    private(set) var rawValue: Int32

    init(_ rawValue: Int32) {
        self.rawValue = rawValue
    }

    deinit {
        close()
    }

    func close() {
        guard rawValue >= 0 else { return }
        Darwin.close(rawValue)
        rawValue = -1
    }
}

struct WorkspaceFileOpenRegularFile {
    let parent: WorkspaceFileDescriptor
    let file: WorkspaceFileDescriptor
    let name: String
}

struct WorkspaceFileTextContent {
    let data: Data
    let text: String
}

enum WorkspaceFilePOSIX {
    private static let openReadFlags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW
    // No `O_DIRECTORY`: with it, opening a symlinked path component fails `ENOTDIR` (the
    // directory check preempts `O_NOFOLLOW`), which would report a symlink escape as a mundane
    // "not a directory" instead of a forbidden boundary crossing. Without it, `O_NOFOLLOW` makes
    // a symlink component fail `ELOOP` -> `.forbidden`, and `requireDirectory` (fstat) still
    // rejects a real non-directory component as `.notDirectory` right after opening it.
    private static let openDirectoryFlags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW

    static func openDirectory(root: URL, components: [String]) throws -> WorkspaceFileDescriptor {
        var current = try openRoot(root)
        try requireDirectory(current)
        for component in components {
            let next = try openAt(parent: current.rawValue, name: component, flags: openDirectoryFlags)
            try requireDirectory(next)
            current = next
        }
        return current
    }

    static func openRegularFile(root: URL, components: [String]) throws -> WorkspaceFileOpenRegularFile {
        guard let name = components.last else { throw WorkspaceFileServiceFailure.invalidPath }
        let parent = try openDirectory(root: root, components: Array(components.dropLast()))
        let file = try openAt(parent: parent.rawValue, name: name, flags: openReadFlags)
        try requireRegularFile(file)
        return WorkspaceFileOpenRegularFile(parent: parent, file: file, name: name)
    }

    static func list(directory: WorkspaceFileDescriptor, relativeDirectory: String) throws -> [WorkspaceDirectoryEntry] {
        let duplicate = Darwin.dup(directory.rawValue)
        guard duplicate >= 0 else { throw failure(for: errno) }
        guard let stream = Darwin.fdopendir(duplicate) else {
            Darwin.close(duplicate)
            throw failure(for: errno)
        }
        defer { Darwin.closedir(stream) }

        var entries: [WorkspaceDirectoryEntry] = []
        while true {
            // Reset before each readdir so a skipped child's openat failure (e.g. ELOOP on a
            // symlink) does not leak into the end-of-stream errno check below and masquerade as a
            // readdir error. Only a genuine readdir failure leaves errno non-zero at break.
            errno = 0
            guard let entry = Darwin.readdir(stream) else { break }
            let name = name(of: entry)
            guard name != ".", name != ".." else { continue }
            guard let child = try? openAt(parent: directory.rawValue, name: name, flags: openReadFlags) else {
                continue
            }
            let mode = try? fileMode(of: child)
            guard let mode else { continue }
            let isDirectory = isDirectory(mode)
            guard isDirectory || isRegularFile(mode) else { continue }
            let path = relativeDirectory.isEmpty ? name : "\(relativeDirectory)/\(name)"
            entries.append(WorkspaceDirectoryEntry(name: name, path: path, isDirectory: isDirectory))
        }
        guard errno == 0 else { throw failure(for: errno) }

        return entries.sorted { lhs, rhs in
            if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
            let comparison = lhs.name.localizedStandardCompare(rhs.name)
            if comparison == .orderedSame { return lhs.name < rhs.name }
            return comparison == .orderedAscending
        }
    }

    static func readUTF8(file: WorkspaceFileDescriptor, maxBytes: Int) throws -> WorkspaceFileTextContent {
        let mode = try fileMode(of: file)
        guard isRegularFile(mode) else { throw WorkspaceFileServiceFailure.notFile }
        var status = stat()
        guard Darwin.fstat(file.rawValue, &status) == 0 else { throw failure(for: errno) }
        guard status.st_size <= off_t(maxBytes) else { throw WorkspaceFileServiceFailure.tooLarge }

        var data = Data()
        data.reserveCapacity(Int(status.st_size))
        var buffer = [UInt8](repeating: 0, count: min(64 * 1024, maxBytes + 1))
        while true {
            let count = buffer.withUnsafeMutableBytes { buffer in
                Darwin.read(file.rawValue, buffer.baseAddress, buffer.count)
            }
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw failure(for: errno)
            }
            guard data.count + count <= maxBytes else { throw WorkspaceFileServiceFailure.tooLarge }
            data.append(buffer, count: count)
        }
        guard !data.contains(0) else { throw WorkspaceFileServiceFailure.binary }
        guard let text = String(data: data, encoding: .utf8) else {
            throw WorkspaceFileServiceFailure.invalidUTF8
        }
        return WorkspaceFileTextContent(data: data, text: text)
    }

    static func writeAll(_ descriptor: Int32, _ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { buffer in
                Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), data.count - offset)
            }
            if written < 0 {
                if errno == EINTR { continue }
                throw WorkspaceFileServiceFailure.writeFailed
            }
            guard written > 0 else { throw WorkspaceFileServiceFailure.writeFailed }
            offset += written
        }
    }

    static func writeAtomically(
        data: Data,
        parent: WorkspaceFileDescriptor,
        name: String,
        writeTemporaryFile: WorkspaceFileTemporaryWriter
    ) throws {
        let temporaryName = ".agentdesk-files-\(UUID().uuidString).tmp"
        let temporary = try openAt(
            parent: parent.rawValue,
            name: temporaryName,
            flags: O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            mode: 0o600
        )
        var renamed = false
        defer {
            temporary.close()
            if !renamed {
                _ = temporaryName.withCString { Darwin.unlinkat(parent.rawValue, $0, 0) }
            }
        }

        try writeTemporaryFile(temporary.rawValue, data)
        try synchronize(temporary.rawValue)
        temporary.close()
        guard rename(parent: parent.rawValue, from: temporaryName, to: name) == 0 else {
            throw WorkspaceFileServiceFailure.writeFailed
        }
        renamed = true
    }

    private static func openRoot(_ root: URL) throws -> WorkspaceFileDescriptor {
        let descriptor = try root.withUnsafeFileSystemRepresentation { path -> Int32 in
            guard let path else { throw WorkspaceFileServiceFailure.notFound }
            let descriptor = Darwin.open(path, openDirectoryFlags)
            guard descriptor >= 0 else { throw failure(for: errno) }
            return descriptor
        }
        return WorkspaceFileDescriptor(descriptor)
    }

    private static func openAt(
        parent: Int32,
        name: String,
        flags: Int32,
        mode: mode_t = 0
    ) throws -> WorkspaceFileDescriptor {
        let descriptor = name.withCString { Darwin.openat(parent, $0, flags, mode) }
        guard descriptor >= 0 else { throw failure(for: errno) }
        return WorkspaceFileDescriptor(descriptor)
    }

    private static func requireDirectory(_ descriptor: WorkspaceFileDescriptor) throws {
        guard isDirectory(try fileMode(of: descriptor)) else {
            throw WorkspaceFileServiceFailure.notDirectory
        }
    }

    private static func requireRegularFile(_ descriptor: WorkspaceFileDescriptor) throws {
        guard isRegularFile(try fileMode(of: descriptor)) else {
            throw WorkspaceFileServiceFailure.notFile
        }
    }

    private static func fileMode(of descriptor: WorkspaceFileDescriptor) throws -> mode_t {
        var status = stat()
        guard Darwin.fstat(descriptor.rawValue, &status) == 0 else { throw failure(for: errno) }
        return status.st_mode
    }

    private static func isDirectory(_ mode: mode_t) -> Bool {
        mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
    }

    private static func isRegularFile(_ mode: mode_t) -> Bool {
        mode & mode_t(S_IFMT) == mode_t(S_IFREG)
    }

    private static func synchronize(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw WorkspaceFileServiceFailure.writeFailed
        }
    }

    private static func rename(parent: Int32, from: String, to: String) -> Int32 {
        while true {
            let result = from.withCString { from in
                to.withCString { to in
                    Darwin.renameat(parent, from, parent, to)
                }
            }
            if result != -1 || errno != EINTR { return result }
        }
    }

    private static func name(of entry: UnsafeMutablePointer<dirent>) -> String {
        withUnsafePointer(to: entry.pointee.d_name) { name in
            name.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN)) { String(cString: $0) }
        }
    }

    private static func failure(for errorNumber: Int32) -> WorkspaceFileServiceFailure {
        switch errorNumber {
        case ENOENT: .notFound
        case ELOOP, EACCES, EPERM: .forbidden
        case ENOTDIR: .notDirectory
        default: .notFound
        }
    }
}
