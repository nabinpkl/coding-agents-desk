import Darwin
import Foundation

/// The seam that terminates Claude Desktop's renderer children.
///
/// Real renderer pids come from the process table, never from CPU or activity heuristics: a wedged
/// conversation pane can be idle or busy, and the deterministic fact is its parent -- every
/// `--type=renderer` child of the Claude main pid is respawned by Chromium when terminated, and a
/// fresh web contents rebuilds its accessibility tree.
protocol AgentWindowRendererReviving {
    /// Records that the composer was found, resetting the missing streak.
    ///
    /// Without the reset, a tree that flaps on a sub-minute cycle would accumulate enough missing time
    /// to be killed -- and each kill reloads the user's window. Found observations are the evidence the
    /// wedge is over.
    func noteComposerFound(for claudeMainPid: pid_t)

    /// Records a composer-missing observation.
    ///
    /// Terminates the target's renderer children when the composer has been CONTINUOUSLY missing for
    /// `minMissing` and the per-process revive cooldown allows; returns the terminated pids, empty when
    /// the streak is too young, the cooldown is still running, or the process has no live renderers.
    func noteComposerMissing(for claudeMainPid: pid_t, now: Date) -> [pid_t]
}

/// Kills the renderer children of a Claude Desktop process so Chromium respawns the web contents.
///
/// Why this is safe and deterministic: a Claude window's conversation pane is a Chromium web contents
/// served by a `Claude Helper (Renderer)` child of the main Claude binary. Chromium builds a web
/// contents' accessibility tree under conditions this host cannot control, and a contents that never
/// built its tree reads as "composer missing" while the field is on screen. Terminating the renderer
/// makes Chromium respawn the contents fresh, which materializes the tree -- verified against the live
/// app: after `kill` of the conversation renderer, the composer `AXTextArea` appeared within a second
/// and stayed, with no AX client attached.
///
/// The kill is SIGTERM, the same signal Chromium itself uses for process teardown. The main process
/// is never touched: only its `--type=renderer` children, matched by parent pid and the Chromium
/// renderer marker, never by path spelling (which the app can rename without notice).
///
/// Two gates keep the kill from becoming a nuisance: the composer must be missing continuously for
/// `minMissing` (a tree that flaps within that window is never killed, and a genuinely wedged tree
/// recovers within it), and one kill per Claude process per `cooldown` bounds a tree that never
/// rebuilds. Both are measured from observations, so a test can drive the exact transitions.
final class AgentWindowRendererReviver: AgentWindowRendererReviving {
    private let processRows: () -> [AgentWindowProcessRow]
    private let terminate: (pid_t) -> Void
    private let minMissing: TimeInterval
    private let cooldown: TimeInterval
    /// First missing observation per Claude main pid; cleared by `noteComposerFound`.
    /// Confined to the composer coordinator's serial queue, which is the only executor that reaches
    /// the composer path.
    private var missingSince: [pid_t: Date] = [:]
    /// Last revive attempt per Claude main pid, same confinement.
    private var lastRevive: [pid_t: Date] = [:]

    init(
        processRows: @escaping () -> [AgentWindowProcessRow] = AgentWindowSessionResolver.liveProcessRows,
        terminate: @escaping (pid_t) -> Void = { kill($0, SIGTERM) },
        minMissing: TimeInterval = Config.claudeRendererReviveMinMissing,
        cooldown: TimeInterval = Config.claudeRendererReviveCooldown
    ) {
        self.processRows = processRows
        self.terminate = terminate
        self.minMissing = minMissing
        self.cooldown = cooldown
    }

    func noteComposerFound(for claudeMainPid: pid_t) {
        missingSince[claudeMainPid] = nil
    }

    func noteComposerMissing(for claudeMainPid: pid_t, now: Date) -> [pid_t] {
        guard let since = missingSince[claudeMainPid] else {
            missingSince[claudeMainPid] = now
            return []
        }
        guard now.timeIntervalSince(since) >= minMissing else { return [] }
        if let last = lastRevive[claudeMainPid], now.timeIntervalSince(last) < cooldown {
            return []
        }
        let pids = rendererPids(of: claudeMainPid)
        guard !pids.isEmpty else { return [] }
        lastRevive[claudeMainPid] = now
        pids.forEach(terminate)
        return pids
    }

    /// Every `--type=renderer` child of the main pid, ascending.
    ///
    /// Parent pid scopes the match to this Claude process, and the renderer marker scopes it to
    /// Chromium's renderer children: GPU, network, utility, and the main binary carry different
    /// markers, and killing one of those would not rebuild web contents. No CPU or activity check --
    /// a wedged renderer can be idle or busy, and either way Chromium respawns it.
    static func rendererPids(of claudeMainPid: pid_t, in rows: [AgentWindowProcessRow]) -> [pid_t] {
        rows
            .filter { $0.parentPid == claudeMainPid && $0.arguments.contains("--type=renderer") }
            .map(\.pid)
            .sorted()
    }

    private func rendererPids(of claudeMainPid: pid_t) -> [pid_t] {
        Self.rendererPids(of: claudeMainPid, in: processRows())
    }
}
