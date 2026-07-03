import Foundation
import ObjectiveC
import UIKit

// ADR-0038 DOM mirror: hosts the rrweb replay surface for the Browser segment of the surface
// switcher, offered only when this session opened a .dom lane (client setting on + host accepted).
// Mirrors the agent-surface extension's associated-object storage (extensions cannot add stored
// properties to the primary class). The surface + lane are created lazily on first Browser select
// (see surfaceSegmentChanged), receive batches, and send taps back up the .dom lane to Chrome.
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
            // Hidden at creation; applySurface(.browser) reveals it on select.
            created.isHidden = true
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

        // ADR-0046 status line: node count comes from the replayer probe.
        surface.onProbe = { [weak surface] _, nodes in surface?.setNodeCount(nodes) }

        // Wire the lane -> surface (pulled fresh so a reconnect's new lane is used), then start it.
        domMirror.onBatch = { [weak surface] json in
            surface?.deliver(rawJSON: json)
            surface?.recordBatch() // ADR-0046: freshness + batch count for the status line
        }
        // ADR-0046/0048: host-pushed diagnostic status (bridge connected, recording tab, emulated).
        domMirror.onStatus = { [weak surface] status in
            surface?.setBridgeStatus(
                connected: status.ext, recordingTab: status.tab, emulated: status.emulated ?? false)
        }
        // ADR-0040: taps in the mirror go back up the .dom lane to Chrome.
        surface.onTap = { [weak self] x, y in self?.pairingClient.activeDomMirror?.sendTap(x: x, y: y) }
        // ADR-0047: scroll drags in the mirror drive the real Chrome tab to scroll.
        surface.onScroll = { [weak self] x, y, dx, dy in
            self?.pairingClient.activeDomMirror?.sendScroll(x: x, y: y, dx: dx, dy: dy)
        }
        // ADR-0048: the Desktop|Mobile control device-emulates the real Chrome tab host-side.
        surface.onEmulateToggle = { [weak self] mobile in
            self?.pairingClient.activeDomMirror?.setEmulate(mobile)
        }
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
