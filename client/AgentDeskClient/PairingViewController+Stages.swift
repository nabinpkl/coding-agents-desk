import UIKit

// Installs the `HostContentStage` bands inside the host content root and hands
// them out to the mount sites. The bands themselves are declared (and their
// order justified) in HostContentStage.swift; the pass-through behavior that
// makes stacking them viable is in PassthroughView.swift.

extension PairingViewController {
    /// The container for one stacking band. Mount into this rather than into
    /// `hostContentView` directly; which band a view belongs to is the decision,
    /// and where it lands in the stack follows from it.
    func stage(_ band: HostContentStage) -> PassthroughView {
        switch band {
        case .backdrop: return backdropStage
        case .chrome: return chromeStage
        case .surface: return surfaceStage
        case .overlay: return overlayStage
        }
    }

    /// Installs the bands, back to front, each filling the host content root.
    ///
    /// Driven by `allCases` rather than four literal `addSubview` calls so the
    /// enum's declaration order is the single thing that decides the stack; a
    /// case moved there moves the band, with nothing here to keep in sync.
    ///
    /// Every band is pinned to the same four edges, so a constraint written
    /// between views in different bands resolves exactly as it did when they
    /// were siblings -- the whole existing layout is unaffected by the split.
    func installHostContentStages() {
        for band in HostContentStage.allCases {
            let container = stage(band)
            container.translatesAutoresizingMaskIntoConstraints = false
            container.accessibilityIdentifier = band.accessibilityIdentifier
            hostContentView.addSubview(container)
            NSLayoutConstraint.activate([
                container.topAnchor.constraint(equalTo: hostContentView.topAnchor),
                container.leadingAnchor.constraint(equalTo: hostContentView.leadingAnchor),
                container.trailingAnchor.constraint(equalTo: hostContentView.trailingAnchor),
                container.bottomAnchor.constraint(equalTo: hostContentView.bottomAnchor)
            ])
        }
    }
}
