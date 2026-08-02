import Foundation

public enum PtySessionLaunch: Equatable, Sendable {
    case shell(cwd: String, shell: String)
    case command(cwd: String, executable: String, arguments: [String])
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
