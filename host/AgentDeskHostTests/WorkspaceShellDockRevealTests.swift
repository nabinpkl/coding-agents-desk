import CoreGraphics
import Testing

/// The dock strip reveals with the SAME mechanism as the other edges (thin bottom band), and its
/// floated position is bridged by a retentionFrame — not by a widened trigger band. These lock the
/// behavior: reveal only at the very bottom, stay open across the gap below the strip, hide on leaving.
struct WorkspaceShellDockRevealTests {
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)

    @Test func dockDescriptorRetentionSpansBottomToStripTop() {
        // Strip floated 16 off the bottom, 160 tall → its top edge is at y=176.
        let layout = computeSlotLayout(
            screen: screen,
            config: SlotLayoutConfig(dockEnrichmentHeight: 160, dockEnrichmentBottomOffset: 16)
        )
        let descriptors = layout.revealDescriptors
        let dock = descriptors.first { $0.surface == .dockEnrichment }
        #expect(dock?.edge == .bottom)
        #expect(dock?.frame == layout.dockEnrichment)
        #expect(dock?.retentionFrame == CGRect(x: 0, y: 0, width: 1440, height: 176))
        // Uniform mechanism: no per-surface band override, and flush edges carry no retentionFrame.
        #expect(dock?.triggerBand == nil)
        #expect(descriptors.first { $0.surface == .sidebar }?.retentionFrame == nil)
    }

    @Test func revealsOnlyAtBottomThenStaysAcrossTheGap() {
        let layout = computeSlotLayout(screen: screen)  // default strip: bottom offset 16, top at y=204
        let descriptors = layout.revealDescriptors
        var machine = WorkspaceShellRevealStateMachine()
        let config = WorkspaceShellRevealConfiguration()

        func move(toY y: CGFloat) {
            let pointer = WorkspaceShellRevealPointer(
                point: CGPoint(x: 700, y: y),
                screen: screen,
                descriptors: descriptors,
                insideSurfaces: [],
                defaultTriggerBand: 4
            )
            machine.send(.pointerMoved(pointer), configuration: config)
        }

        // Hovering above the strip but not at the edge does NOT reveal it (the bug that regressed).
        move(toY: 120)
        #expect(!machine.state.contains(.dockEnrichment))

        // Only reaching the very bottom edge (within the 4pt band) reveals it.
        move(toY: 1)
        #expect(machine.state.contains(.dockEnrichment))

        // Moving up into the gap below the floated strip keeps it revealed (retentionFrame).
        move(toY: 8)
        #expect(machine.state.contains(.dockEnrichment))

        // Moving far up leaves both the band and the retention region → hides.
        move(toY: 400)
        #expect(!machine.state.contains(.dockEnrichment))
    }

    @Test func heldDockRevealSurvivesPointerLeavingRetentionRegion() {
        let layout = computeSlotLayout(screen: screen)
        var machine = WorkspaceShellRevealStateMachine()
        let pointer = WorkspaceShellRevealPointer(
            point: CGPoint(x: 700, y: 500),
            screen: screen,
            descriptors: layout.revealDescriptors,
            insideSurfaces: [],
            defaultTriggerBand: 4
        )

        machine.send(
            .pointerMoved(pointer),
            configuration: WorkspaceShellRevealConfiguration(held: [.dockEnrichment])
        )

        #expect(machine.state.contains(.dockEnrichment))
    }
}
