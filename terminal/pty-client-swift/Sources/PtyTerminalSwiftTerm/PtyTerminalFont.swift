import CoreText
import Foundation

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum PtyTerminalFont {
    static let resourceURL: URL = {
        guard let url = Bundle.module.url(
            forResource: "JetBrainsMonoNerdFontMono-Regular",
            withExtension: "ttf"
        ) else {
            preconditionFailure("Bundled JetBrains Mono Nerd Font resource is missing")
        }
        return url
    }()

    static let postScriptName: String = {
        guard
            let descriptors = CTFontManagerCreateFontDescriptorsFromURL(resourceURL as CFURL)
                as? [CTFontDescriptor],
            let descriptor = descriptors.first,
            let name = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
        else {
            preconditionFailure("Bundled JetBrains Mono Nerd Font metadata is unreadable")
        }
        return name
    }()

    static func make(pointSize: CGFloat) -> PtyTerminalPlatformFont {
        _ = registration

        #if canImport(AppKit)
        guard let font = NSFont(name: postScriptName, size: pointSize) else {
            preconditionFailure("Registered terminal font \(postScriptName) is unavailable to AppKit")
        }
        return font
        #elseif canImport(UIKit)
        guard let font = UIFont(name: postScriptName, size: pointSize) else {
            preconditionFailure("Registered terminal font \(postScriptName) is unavailable to UIKit")
        }
        return font
        #endif
    }

    private static let registration: Void = {
        let availableNames = CTFontManagerCopyAvailablePostScriptNames() as? [String] ?? []
        guard !availableNames.contains(postScriptName) else { return }

        var unmanagedError: Unmanaged<CFError>?
        guard CTFontManagerRegisterFontsForURL(resourceURL as CFURL, .process, &unmanagedError) else {
            let error = unmanagedError?.takeRetainedValue()
            preconditionFailure(
                "Bundled JetBrains Mono Nerd Font registration failed: \(String(describing: error))"
            )
        }
    }()
}
