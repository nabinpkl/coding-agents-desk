import Foundation
import UIKit

enum MediaStack {
    @MainActor
    static func makeVideoSink() -> VideoFrameSink {
        OwnedMediaVideoSink()
    }
}
