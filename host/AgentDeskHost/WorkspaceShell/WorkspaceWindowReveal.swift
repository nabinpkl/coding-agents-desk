import OSLog

/// Brings one already-open window to the user: makes the Desktop it lives on the active one, then
/// raises it there. The two halves are in that order because a window cannot be raised onto a Desktop
/// it is not on.
///
/// Shared by every family the top bar lists, so the ordering, what happens when the Desktop refuses,
/// and when the window is re-checked are decided once rather than once per registry.
@MainActor
enum WorkspaceWindowReveal {
    /// `raise` resolves the window itself rather than being handed one: the Desktop switch is a real
    /// wait, and the window can be closed from its own titlebar while the Desktop is still animating,
    /// so whether there is still anything to raise is only knowable afterwards.
    static func reveal(
        desktop: WorkspaceDesktopAssignment,
        activateDesktop: DesktopActivating?,
        logger: Logger,
        family: String,
        raise: @escaping @MainActor () -> Void
    ) {
        guard let activateDesktop else {
            raise()
            return
        }
        Task { @MainActor in
            let reached = await activateDesktop(desktop)
            if !reached {
                // Raised anyway. The window may already be reachable (the switch is also refused when
                // Spaces cannot be read at all), and refusing to act on the click would leave the user
                // with a silent no-op instead of a window they can look for.
                logger.error(
                    "\(family, privacy: .public) focus: Desktop \(desktop.ordinal + 1, privacy: .public) on display \(desktop.displayID, privacy: .public) did not become active"
                )
            }
            raise()
        }
    }
}
