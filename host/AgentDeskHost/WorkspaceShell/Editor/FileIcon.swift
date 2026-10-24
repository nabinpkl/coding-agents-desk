import AppKit
import CoreText
import os

/// Maps a file to a recognisable, colour-coded icon glyph drawn from the vendored Symbols
/// Nerd Font (Seti + Devicon sets, MIT — see ADR-0005). Real brand marks (the Python, Swift,
/// Markdown, Docker… glyphs) at any size, shared by the file tree and the Source Control
/// list so a `.py` looks the same everywhere. Not a full icon theme — a curated map of the
/// kinds that actually show up, with a plain-document default.
///
/// The font is registered once from the app bundle; if it can't be loaded (e.g. a bare
/// non-bundled run) we fall back to a generic SF Symbol so icons never render blank.
// UI code: icon resolution + its static caches are touched only from the main thread (FilePane
// cells). MainActor isolation makes the static `nerdFont`/`imageCache` concurrency-safe.
@MainActor
public enum FileIcon {
    /// A tinted icon image sized for a sidebar row. Folders get one look; files are keyed
    /// off their extension (or whole name, for dotfiles like `.gitignore`).
    public static func image(for url: URL, isDirectory: Bool) -> NSImage? {
        let glyph = spec(for: url, isDirectory: isDirectory)
        if let font = nerdFont {
            return cachedGlyphImage(scalar: glyph.scalar, color: glyph.color, font: font)
        }
        return NSImage(systemSymbolName: "doc.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular).applying(.init(paletteColors: [glyph.color])))
    }

    // MARK: - Type → glyph map

    private struct Glyph { let scalar: Unicode.Scalar; let color: NSColor }

    private static func glyph(_ code: UInt32, _ color: NSColor) -> Glyph {
        Glyph(scalar: Unicode.Scalar(code)!, color: color)
    }

    /// Codepoints are Nerd Font Private-Use-Area values (Devicon `dev-*` brand marks where
    /// they exist, else Seti `seti-*` file-type marks); resolved from the official
    /// glyphnames map, not guessed.
    private static func spec(for url: URL, isDirectory: Bool) -> Glyph {
        if isDirectory { return glyph(0xE613, .systemTeal) }  // seti-folder

        switch url.lastPathComponent.lowercased() {
        case ".gitignore", ".gitattributes", ".gitmodules": return glyph(0xE65D, .systemOrange)  // seti-git
        case ".env", ".env.local", ".env.production": return glyph(0xE615, .systemGreen)  // seti-config
        case "dockerfile": return glyph(0xE7B0, .systemBlue)  // dev-docker
        case "license", "license.md", "license.txt": return glyph(0xE60A, .systemGray)  // seti-license
        case "package.resolved", "cargo.lock", "podfile.lock", "package-lock.json":
            return glyph(0xE672, .systemGray)  // seti-lock
        default: break
        }

        switch url.pathExtension.lowercased() {
        case "swift": return glyph(0xE755, .systemOrange)        // dev-swift
        case "py", "pyw": return glyph(0xE73C, .systemBlue)      // dev-python
        case "js", "mjs", "cjs", "jsx": return glyph(0xE781, .systemYellow)  // dev-javascript
        case "ts", "tsx": return glyph(0xE628, .systemBlue)      // seti-typescript
        case "json", "jsonc": return glyph(0xE60B, .systemYellow)  // seti-json
        case "yaml", "yml": return glyph(0xE6A8, .systemPurple)  // seti-yml
        case "toml", "ini", "cfg", "conf": return glyph(0xE615, .systemPurple)  // seti-config
        case "md", "markdown": return glyph(0xE73E, .systemBlue) // dev-markdown
        case "rst": return glyph(0xE609, .systemBlue)            // seti-markdown
        case "txt", "text", "log": return glyph(0xE64E, .secondaryLabelColor)  // seti-default
        case "html", "htm": return glyph(0xE60E, .systemOrange)  // seti-html
        case "xml", "plist": return glyph(0xE615, .systemGray)   // seti-config
        case "css", "scss", "sass", "less": return glyph(0xE749, .systemPink)  // dev-css3
        case "sh", "bash", "zsh", "fish": return glyph(0xE691, .systemGreen)   // seti-shell
        case "rb": return glyph(0xE605, .systemRed)              // seti-ruby
        case "go": return glyph(0xE724, .systemTeal)             // dev-go
        case "rs": return glyph(0xE7A8, .systemOrange)           // dev-rust
        case "c", "h": return glyph(0xE649, .systemBlue)         // seti-c
        case "cpp", "cc", "cxx", "hpp", "m", "mm": return glyph(0xE646, .systemBlue)  // seti-cpp
        case "java", "kt", "kts": return glyph(0xE738, .systemRed)  // dev-java
        case "png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "bmp", "ico", "icns":
            return glyph(0xE60D, .systemPurple)                  // seti-image
        case "pdf": return glyph(0xE67D, .systemRed)             // seti-pdf
        case "docx": return glyph(0xE64E, .systemBlue)           // seti-default document
        case "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar": return glyph(0xE6AA, .systemGray)  // seti-zip
        case "lock": return glyph(0xE672, .systemGray)           // seti-lock
        default: return glyph(0xE64E, .secondaryLabelColor)      // seti-default
        }
    }

    // MARK: - Font + rendering

    private static let logger = Logger(subsystem: Config.logSubsystem, category: "file-icon")
    private static let pointSize: CGFloat = 13
    private static let boxSize = NSSize(width: 16, height: 16)

    /// The registered Nerd Font, resolved by the font's own PostScript name (so we never
    /// hardcode it) and cached. `nil` if the bundled font can't be found or registered.
    private static let nerdFont: NSFont? = {
        guard let url = Bundle.main.url(forResource: "SymbolsNerdFont-Regular", withExtension: "ttf") else {
            logger.error("Nerd Font not found in bundle; falling back to SF Symbols")
            return nil
        }
        var error: Unmanaged<CFError>?
        guard CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) else {
            logger.error("Nerd Font registration failed: \(String(describing: error?.takeRetainedValue()), privacy: .public)")
            return nil
        }
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
              let first = descriptors.first,
              let psName = CTFontDescriptorCopyAttribute(first, kCTFontNameAttribute) as? String,
              let font = NSFont(name: psName, size: pointSize)
        else {
            logger.error("Nerd Font descriptor/name unreadable; falling back to SF Symbols")
            return nil
        }
        return font
    }()

    private static var imageCache: [String: NSImage] = [:]

    /// Draw a single glyph centred in a row-sized box, tinted. Cached by codepoint + colour
    /// (both fixed per file type), since cells re-render on every reload.
    private static func cachedGlyphImage(scalar: Unicode.Scalar, color: NSColor, font: NSFont) -> NSImage {
        let key = "\(scalar.value)-\(color.description)"
        if let cached = imageCache[key] { return cached }

        let attributed = NSAttributedString(
            string: String(scalar),
            attributes: [.font: font, .foregroundColor: color]
        )
        let glyphBounds = attributed.boundingRect(with: .zero, options: .usesLineFragmentOrigin)
        let image = NSImage(size: boxSize)
        image.lockFocus()
        let origin = NSPoint(
            x: (boxSize.width - glyphBounds.width) / 2,
            y: (boxSize.height - glyphBounds.height) / 2
        )
        attributed.draw(at: origin)
        image.unlockFocus()

        imageCache[key] = image
        return image
    }
}
