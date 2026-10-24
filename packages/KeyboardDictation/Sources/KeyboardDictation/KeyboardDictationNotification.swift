import CoreFoundation
import Foundation

public enum KeyboardDictationNotification {
    public static let command = "agentdesk.keyboard-dictation.command"
    public static let service = "agentdesk.keyboard-dictation.service"

    public static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString),
            nil,
            nil,
            true
        )
    }
}

public final class KeyboardDictationNotificationObservation:
    @unchecked Sendable
{
    private let name: String
    private let handler: @Sendable () -> Void

    public init(
        name: String,
        handler: @escaping @Sendable () -> Void
    ) {
        self.name = name
        self.handler = handler
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let observation = Unmanaged<
                    KeyboardDictationNotificationObservation
                >.fromOpaque(observer).takeUnretainedValue()
                DispatchQueue.main.async {
                    observation.handler()
                }
            },
            name as CFString,
            nil,
            .deliverImmediately
        )
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(name as CFString),
            nil
        )
    }
}
