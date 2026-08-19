// The manual resolution ladder, shared so the host and the client cannot disagree about
// what a rung means (ADR-0008).
//
// The rungs are heights, not fractions. A fraction of native is a different picture on
// every display -- 50% of a Retina panel is one encoded pixel per macOS point, 50% of a
// 1x external is half of one -- so a percentage told the user which lever they pulled but
// not what they would get. A height is the same picture everywhere it is available, and
// the top rung is whatever the selected display natively captures, so "full" is full.
//
// Widths are never chosen, only derived: the encode path scales both axes by the single
// factor `resolutionScale`, so the aspect ratio is preserved by construction and there is
// nothing here that could stretch or crop a frame.

import Foundation

public enum MediaResolutionLadder: Sendable {
    /// Candidate rungs below native, in encoded pixel height. 360 is the floor because
    /// below it the picture stops being usable for its purpose, not because the encoder
    /// objects. The list is deliberately familiar video heights; a display's own native
    /// height is appended as the last rung, so most displays use only part of this.
    public static let candidateHeights: [Int] = [360, 480, 540, 720, 900, 1080, 1440, 1800, 2160]

    public struct Stop: Equatable, Sendable {
        /// The rung's nominal height. Equal to `height` except where evening it changed it.
        public let nominalHeight: Int
        public let width: Int
        public let height: Int
        /// What goes on the wire as `ClientMediaQualityTarget.resolutionScale`.
        public let resolutionScale: Double
        /// True for the top rung, where the encoder gets the display's native frame untouched.
        public let isNative: Bool

        public init(nominalHeight: Int, width: Int, height: Int, resolutionScale: Double, isNative: Bool) {
            self.nominalHeight = nominalHeight
            self.width = width
            self.height = height
            self.resolutionScale = resolutionScale
            self.isNative = isNative
        }

        public var label: String { "\(width) × \(height)" }
    }

    /// The ladder for one display, ascending, always ending at that display's native size.
    ///
    /// A display smaller than the floor still gets exactly one rung -- its own native size --
    /// because a slider with nothing on it cannot express the one setting that always exists.
    public static func stops(nativeWidth: Int, nativeHeight: Int) -> [Stop] {
        guard nativeWidth > 0, nativeHeight > 0 else { return [] }
        let native = Stop(
            nominalHeight: nativeHeight,
            width: evenDimension(Double(nativeWidth)),
            height: evenDimension(Double(nativeHeight)),
            resolutionScale: 1.0,
            isNative: true
        )
        let below = candidateHeights
            .filter { $0 < nativeHeight }
            .map { rung -> Stop in
                let scale = Double(rung) / Double(nativeHeight)
                return Stop(
                    nominalHeight: rung,
                    // Mirrors the encode path's own rounding so the number the user reads is
                    // the number the encoder emits, rather than one off from it.
                    width: evenDimension(Double(nativeWidth) * scale),
                    height: evenDimension(Double(nativeHeight) * scale),
                    resolutionScale: scale,
                    isNative: false
                )
            }
        return below + [native]
    }

    /// The rung a stored height selects on this display, clamped to native.
    ///
    /// Clamping rather than dropping is what lets a height persist across a display change:
    /// 1440 stays 1440 where the display has it and quietly becomes "full" where it does not,
    /// instead of resetting to something the user never picked.
    public static func stop(forStoredHeight height: Int?, nativeWidth: Int, nativeHeight: Int) -> Stop? {
        let ladder = stops(nativeWidth: nativeWidth, nativeHeight: nativeHeight)
        guard let last = ladder.last else { return nil }
        guard let height else { return last }
        return ladder.first { $0.nominalHeight >= height } ?? last
    }

    /// H.264 needs even dimensions. Identical to the encode path's rounding on purpose:
    /// two roundings that merely look alike would drift and nobody would notice until a
    /// label disagreed with a frame.
    public static func evenDimension(_ value: Double) -> Int {
        let rounded = max(2, Int(value.rounded(.down)))
        return rounded.isMultiple(of: 2) ? rounded : rounded - 1
    }
}
