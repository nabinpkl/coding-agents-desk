import Foundation

public enum PtySessionLaunch: Equatable, Sendable {
    case shell(cwd: String, shell: String)
    case command(cwd: String, executable: String, arguments: [String])
}

public enum PtySessionLifetime: Equatable, Sendable {
    case persistent
    case leased
}

extension PtySessionLaunch {
    var proto: Pty_V1_CreateOrAttach.OneOf_Launch {
        switch self {
        case .shell(let cwd, let shell):
            return .shellLaunch(.with {
                $0.cwd = cwd
                $0.shell = shell
            })
        case .command(let cwd, let executable, let arguments):
            return .commandLaunch(.with {
                $0.cwd = cwd
                $0.executable = executable
                $0.arguments = arguments
            })
        }
    }
}

extension PtySessionLifetime {
    var proto: Pty_V1_SessionLifetime {
        switch self {
        case .persistent: .persistent
        case .leased: .leased
        }
    }

    init(proto: Pty_V1_SessionLifetime) throws {
        switch proto {
        case .persistent:
            self = .persistent
        case .leased:
            self = .leased
        case .unspecified:
            throw PtyClientError.invalidSessionLifetime(proto.rawValue)
        case .UNRECOGNIZED(let rawValue):
            throw PtyClientError.invalidSessionLifetime(rawValue)
        }
    }
}
