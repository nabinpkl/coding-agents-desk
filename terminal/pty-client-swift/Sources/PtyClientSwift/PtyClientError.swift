import Foundation

public enum PtyClientError: Error, Equatable {
    case closed
    case invalidFrameLength(Int)
    case invalidProtocolVersion(UInt32)
    case missingPayload
    case unexpectedPayload(String)
    case daemonError(String)
    case socketPathUnavailable(String)
    case eventsAlreadyStarted
}
