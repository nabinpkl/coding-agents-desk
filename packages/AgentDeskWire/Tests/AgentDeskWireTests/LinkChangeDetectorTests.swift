import Foundation
import Network
import Testing
@testable import AgentDeskWire

/// Phase 1 of the handover architecture. These pin the discrimination the device run depends
/// on: if the detector cannot tell a real handover from ordinary churn, the measurement it
/// exists to produce is worthless and Phase 2 would pick its trigger from noise.
struct LinkChangeDetectorTests {

    // MARK: - The case that motivated the whole thing

    @Test func aCellularAddressChangeIsCaughtEvenThoughThePathLooksIdentical() {
        // The 5G -> 3G freeze. The phone got a new IPv6 (2001:56b:3ffa:... -> 2001:56b:3ff3:...)
        // while `interfaceType` stayed `cellular` and the path stayed `satisfied`, so the
        // NWPath snapshot before and after are byte-identical. Only the address sees it.
        let detector = LinkChangeDetector()
        detector.sampleAddresses(digest: 0xAAAA_AAAA)
        detector.sampleAddresses(digest: 0xBBBB_BBBB)

        let report = detector.reportSnapshot()
        #expect(report.total == 1)
        #expect(report.causes?.contains("localAddress") == true)
    }

    @Test func aPathSnapshotThatDidNotMoveReportsNothing() {
        // The control for the test above: an identical snapshot must not register, or every
        // report window would claim a handover and the signal would be useless.
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))

        #expect(detector.reportSnapshot().total == 0)
    }

    // MARK: - Baselines are not transitions

    @Test func theFirstObservationOfEachSignalIsABaseline() {
        // Without this a session opens by reporting that the interface, the path and the
        // address all just changed, burying the one real transition that follows.
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.sampleAddresses(digest: 0x1234)

        #expect(detector.reportSnapshot().total == 0)
    }

    // MARK: - Each cause fires on its own transition

    @Test func anInterfaceSwitchIsCaught() {
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))

        let report = detector.reportSnapshot()
        #expect(report.total == 1)
        #expect(report.causes == "interfaceType(wifi->cellular)")
    }

    @Test func aPathStatusLossIsCaught() {
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.notePath(snapshot(interface: .wifi, status: .unsatisfied))

        #expect(detector.reportSnapshot().causes == "pathStatus(satisfied->unsatisfied)")
    }

    @Test func aRadioHandoverIsCaught() {
        let detector = LinkChangeDetector()
        detector.noteRadioChange(from: "NRNSA", to: "HSDPA")

        let report = detector.reportSnapshot()
        #expect(report.total == 1)
        #expect(report.causes == "radioAccess(NRNSA->HSDPA)")
    }

    @Test func ourOwnStallEvidenceIsCaught() {
        // The backstop: it caught the measured freeze at ~1.6s, about 16 seconds before the
        // transport reported anything, and it is the only cause that works when the platform
        // never reports the change at all.
        let detector = LinkChangeDetector()
        detector.noteStall(gapMs: 1589.7, hostQuietMs: 28)

        #expect(detector.reportSnapshot().causes == "stall(gap=1590ms quiet=28ms)")
    }

    @Test func oneHandoverFiringSeveralCausesReportsAllOfThem() {
        // A real handover trips more than one signal, and which one fired FIRST is the entire
        // point of Phase 1 -- so they must not collapse into a single generic "changed".
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.sampleAddresses(digest: 0x1111)

        detector.notePath(snapshot(interface: .cellular, status: .satisfied))
        detector.sampleAddresses(digest: 0x2222)
        detector.noteRadioChange(from: "none", to: "NRNSA")

        let report = detector.reportSnapshot()
        #expect(report.total == 3)
        let causes = try? #require(report.causes)
        #expect(causes?.contains("interfaceType(wifi->cellular)") == true)
        #expect(causes?.contains("localAddress") == true)
        #expect(causes?.contains("radioAccess(none->NRNSA)") == true)
    }

    // MARK: - Reporting survives a lost report (R208)

    @Test func aLostReportDoesNotDestroyTheChangeItWasCarrying() {
        // The R208 regression, and the reason these counters are cumulative.
        //
        // The report is a datagram sent over the link it describes, and the send is dropped
        // silently on failure. Measured on device: report loss was 0.2% at rest but 18% during
        // the freeze, because the link change is itself what makes the report go missing. Under
        // the old drain-on-read counter a real wifi-to-cellular switch was drained into a report
        // that never arrived, and all 976 delivered reports read `linkChanges=0`.
        //
        // So: take a report and throw it away, exactly as the network did. The next one must
        // still carry the change.
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))

        _ = detector.reportSnapshot() // lost in flight

        let delivered = detector.reportSnapshot()
        #expect(delivered.total == 1)
        #expect(delivered.causes?.contains("interfaceType(wifi->cellular)") == true)
    }

    @Test func theTotalKeepsAccumulatingAcrossReports() {
        // Cumulative means the host can diff consecutive reports to recover the per-window
        // count. If the total reset, a diff would go negative and read as garbage.
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))
        #expect(detector.reportSnapshot().total == 1)

        detector.noteRadioChange(from: "NRNSA", to: "HSDPA")
        #expect(detector.reportSnapshot().total == 2)
    }

    @Test func newSinceLastReportIsPerWindowEvenThoughTheTotalIsNot() {
        // The local console gate reads this one. It has to fall back to zero on a quiet window,
        // or a single early change would make every later window log forever.
        let detector = LinkChangeDetector()
        detector.notePath(snapshot(interface: .wifi, status: .satisfied))
        detector.notePath(snapshot(interface: .cellular, status: .satisfied))
        #expect(detector.reportSnapshot().newSinceLastReport == 1)

        let quiet = detector.reportSnapshot()
        #expect(quiet.newSinceLastReport == 0)
        #expect(quiet.total == 1)
    }

    @Test func aFlapCannotGrowTheRetainedDetailWithoutBound() {
        // The count stays exact so a flap is still visible as a number; only the retained
        // detail is capped, so a pathological flap cannot grow the report unboundedly.
        let detector = LinkChangeDetector()
        for index in 0..<40 {
            detector.noteRadioChange(from: "a\(index)", to: "b\(index)")
        }
        let report = detector.reportSnapshot()
        #expect(report.total == 40)
        let causeCount = report.causes?.split(separator: ",").count ?? 0
        #expect(causeCount == 8)
        // Newest wins. Now that the ring is sticky rather than drained, keeping the OLDEST
        // eight would pin the window shut on startup noise and hide the transition that
        // actually broke the session -- the only one worth reading during an incident.
        #expect(report.causes?.contains("radioAccess(a39->b39)") == true)
        #expect(report.causes?.contains("radioAccess(a0->b0)") == false)
    }

    // MARK: - Address digest

    @Test func theAddressDigestIsStableForTheSameMachineAcrossCalls() {
        // If it were not stable, every window would report a spurious address change and the
        // one signal that catches the 3G case would be pure noise.
        #expect(LinkChangeDetector.currentAddressDigest() == LinkChangeDetector.currentAddressDigest())
    }

    @Test func theAddressDigestIsNonZeroOnAMachineWithAnInterface() {
        // Zero is the failure sentinel; a test machine always has at least one non-loopback
        // address, so a zero here means getifaddrs failed rather than "no addresses".
        #expect(LinkChangeDetector.currentAddressDigest() != 0)
    }

    @Test func theDigestDistinguishesDifferentAddressSets() {
        #expect(LinkChangeDetector.fnv1a("en0=10.0.0.5") != LinkChangeDetector.fnv1a("en0=10.0.0.6"))
    }

    // MARK: - Helpers

    /// `NWPath` cannot be constructed, so the snapshot is built through the same memberwise
    /// shape the real one produces.
    private func snapshot(
        interface: NWInterface.InterfaceType,
        status: NWPath.Status
    ) -> LinkPathSnapshot {
        LinkPathSnapshot(
            interfaceType: {
                switch interface {
                case .wifi: return "wifi"
                case .cellular: return "cellular"
                case .wiredEthernet: return "wired"
                case .loopback: return "loopback"
                default: return "other"
                }
            }(),
            expensive: interface == .cellular,
            constrained: false,
            ultraConstrained: false,
            linkQuality: "good",
            status: {
                switch status {
                case .satisfied: return "satisfied"
                case .unsatisfied: return "unsatisfied"
                default: return "requiresConnection"
                }
            }(),
            unsatisfiedReason: status == .satisfied ? nil : "notAvailable"
        )
    }
}
