import Foundation

enum KeyboardDictationLifecyclePolicy {
    static func acceptsLaneCallback(
        callbackGeneration: UUID,
        activeGeneration: UUID?
    ) -> Bool {
        callbackGeneration == activeGeneration
    }

    static func acceptsSocketCompletion(
        requestID: String,
        activeRequestID: String?
    ) -> Bool {
        requestID == activeRequestID
    }

    static func acceptsCaptureCallback(
        captureSessionID: UUID,
        activeSessionID: UUID?
    ) -> Bool {
        captureSessionID == activeSessionID
    }
}
