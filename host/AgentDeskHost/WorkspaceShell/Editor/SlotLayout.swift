import CoreGraphics

/// The regions of the shell, in AppKit screen coordinates (origin bottom-left).
/// `sidebar`, `topBar`, and `dockEnrichment` are the frames the auto-hiding surfaces occupy
/// when revealed; each spans or sits near its screen edge so an edge hover slides the surface in.
/// `slot` is the work area the active slot window is snapped into. Unpinned, the
/// surfaces are Dock-like — floating over the slot only while revealed, reserving no space — so
/// the slot is the entire screen. A pinned sidebar or top bar instead reserves its strip: the
/// slot insets by the sidebar width and/or top-bar height so the window sits beside it.
public struct SlotLayout: Equatable {
    public let sidebar: CGRect
    public let topBar: CGRect
    public let dockEnrichment: CGRect
    public let slot: CGRect

    public init(sidebar: CGRect, topBar: CGRect, dockEnrichment: CGRect = .zero, slot: CGRect) {
        self.sidebar = sidebar
        self.topBar = topBar
        self.dockEnrichment = dockEnrichment
        self.slot = slot
    }
}

/// Tunable dimensions of the shell edge surfaces. Everything else is derived from the screen.
public struct SlotLayoutConfig: Equatable {
    public let sidebarWidth: CGFloat
    public let topBarHeight: CGFloat
    public let dockEnrichmentHeight: CGFloat
    public let dockEnrichmentHorizontalInset: CGFloat
    public let dockEnrichmentBottomOffset: CGFloat

    public init(
        sidebarWidth: CGFloat = 240,
        topBarHeight: CGFloat = 38,
        dockEnrichmentHeight: CGFloat = 188,
        dockEnrichmentHorizontalInset: CGFloat = 12,
        dockEnrichmentBottomOffset: CGFloat = 16
    ) {
        self.sidebarWidth = sidebarWidth
        self.topBarHeight = topBarHeight
        self.dockEnrichmentHeight = dockEnrichmentHeight
        self.dockEnrichmentHorizontalInset = dockEnrichmentHorizontalInset
        self.dockEnrichmentBottomOffset = dockEnrichmentBottomOffset
    }
}

extension SlotLayout {
    /// The shell's edge-reveal descriptors, derived from this one layout (donor parity): the sidebar
    /// and top bar sit flush at their edges; the dock strip is floated off the bottom, so its
    /// retentionFrame spans from the screen bottom up to the strip's top edge — keeping it revealed once
    /// the pointer has bridged the gap or is over the strip, while the reveal still triggers only in the
    /// thin bottom band. Single source: the same layout that positions the panels defines the reveal.
    var revealDescriptors: [WorkspaceShellRevealDescriptor] {
        let shellBounds = sidebar.union(topBar).union(slot).union(dockEnrichment)
        let dockRetention = CGRect(
            x: shellBounds.minX,
            y: shellBounds.minY,
            width: shellBounds.width,
            height: max(0, dockEnrichment.maxY - shellBounds.minY)
        )
        return [
            WorkspaceShellRevealDescriptor(surface: .sidebar, edge: .left, frame: sidebar),
            WorkspaceShellRevealDescriptor(surface: .topBar, edge: .top, frame: topBar),
            WorkspaceShellRevealDescriptor(
                surface: .dockEnrichment, edge: .bottom, frame: dockEnrichment, retentionFrame: dockRetention
            ),
        ]
    }
}

/// A rect of fixed `size`, centered inside `outer`. Used to place a slot window at a
/// specific size (e.g. a normal-terminal-sized window) rather than a fraction of the slot.
public func centeredRect(in outer: CGRect, size: CGSize) -> CGRect {
    CGRect(
        x: outer.midX - size.width / 2,
        y: outer.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// Pure geometry: from `screen`, the left/top bar frames and the work-area slot. No AppKit,
/// no I/O. Bar sizes are clamped to the screen so the result stays valid on tiny or
/// degenerate frames. The bar frames always span the full screen edge (an edge hover
/// anywhere reveals them); a **pinned** bar additionally insets the slot by its thickness so
/// the slot window sits beside it instead of under it. Unpinned, the slot is the whole
/// screen (the bars float over it, reserving no space).
public func computeSlotLayout(
    screen: CGRect,
    config: SlotLayoutConfig = SlotLayoutConfig(),
    sidebarPinned: Bool = false,
    topBarPinned: Bool = false
) -> SlotLayout {
    let sidebarWidth = max(0, min(config.sidebarWidth, screen.width))
    let topBarHeight = max(0, min(config.topBarHeight, screen.height))
    let dockHorizontalInset = max(0, min(config.dockEnrichmentHorizontalInset, screen.width / 2))
    let dockBottomOffset = max(0, min(config.dockEnrichmentBottomOffset, screen.height))
    let dockHeight = max(0, min(config.dockEnrichmentHeight, screen.height - dockBottomOffset))
    let dockWidth = max(0, screen.width - dockHorizontalInset * 2)

    let sidebar = CGRect(
        x: screen.minX, y: screen.minY,
        width: sidebarWidth, height: screen.height
    )
    let topBar = CGRect(
        x: screen.minX, y: screen.maxY - topBarHeight,
        width: screen.width, height: topBarHeight
    )
    let dockEnrichment = CGRect(
        x: screen.minX + dockHorizontalInset,
        y: screen.minY + dockBottomOffset,
        width: dockWidth,
        height: dockHeight
    )

    let leftInset = sidebarPinned ? sidebarWidth : 0
    let topInset = topBarPinned ? topBarHeight : 0
    let slot = CGRect(
        x: screen.minX + leftInset, y: screen.minY,
        width: screen.width - leftInset, height: screen.height - topInset
    )
    return SlotLayout(sidebar: sidebar, topBar: topBar, dockEnrichment: dockEnrichment, slot: slot)
}
