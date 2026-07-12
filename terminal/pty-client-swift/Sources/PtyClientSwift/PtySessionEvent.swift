import Foundation

public enum PtySessionEvent: Equatable, Sendable {
    case attached(PtySessionAttachment)
    case output(Data)
    case detachedByManager(UInt64)
    case exited(Int32)
    case error(String)
}
