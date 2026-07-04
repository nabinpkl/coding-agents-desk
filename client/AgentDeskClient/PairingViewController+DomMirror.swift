import Foundation
import ObjectiveC
import UIKit

// ADR-0038 DOM mirror: hosts the rrweb replay surface on connect when this session opened a .dom
// lane (client setting on + host accepted). Mirrors the agent-surface extension's associated-object
// storage (extensions cannot add stored properties to the primary class). Read-only v1: the surface
// receives batches and is shown full-bleed; taps back to Chrome are Phase 5.
extension PairingViewController {
    private enum DomKeys {
        nonisolated(unsafe) static var domMirrorSurface: UInt8 = 0
    }

    var domMirrorSurface: DomMirrorSurface? {
        get { objc_getAssociatedObject(self, &DomKeys.domMirrorSurface) as? DomMirrorSurface }
        set { objc_setAssociatedObject(self, &DomKeys.domMirrorSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    // Idempotent. Creates the replay surface once, wires the active .dom lane to it, and starts the
    // lane. Re-wires onBatch to the current lane on a reconnect. No-op when this session has no .dom
    // lane (DOM mirroring off, or host rejected it).
    @discardableResult
    func ensureDomMirrorSurface() -> DomMirrorSurface? {
        guard let domMirror = pairingClient.activeDomMirror else { return nil }

        let surface: DomMirrorSurface
        if let existing = domMirrorSurface {
            surface = existing
        } else {
            let created = DomMirrorSurface()
            created.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(created)
            let top = surfaceSegmentedControl.map {
                created.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 8)
            } ?? created.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
            NSLayoutConstraint.activate([
                top,
                created.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                created.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                created.bottomAnchor.constraint(equalTo: view.bottomAnchor)
            ])
            domMirrorSurface = created
            surface = created
        }

        // Wire the lane -> surface (pulled fresh so a reconnect's new lane is used), then start it.
        domMirror.onBatch = { [weak surface] json in surface?.deliver(rawJSON: json) }
        domMirror.start()

        if let seg = surfaceSegmentedControl { view.bringSubviewToFront(seg) }
        return surface
    }

    func teardownDomMirrorSurface() {
        pairingClient.activeDomMirror?.onBatch = nil
        domMirrorSurface?.teardown()
        domMirrorSurface?.removeFromSuperview()
        domMirrorSurface = nil
    }
}
