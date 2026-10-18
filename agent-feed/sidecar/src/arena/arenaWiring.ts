import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaService } from "@/arena/arenaService";
import { ArenaStore } from "@/arena/arenaStore";
import { arenaClaudeEffort, arenaClaudeModel, arenaHome, arenaRoot } from "@/arena/arenaConfig";
import { runClaudeContestant } from "@/arena/contestants/claudeContestant";
import { runOpencodeContestant, type OpencodeContestantBackend } from "@/arena/contestants/opencodeContestant";
import { runClaudeTerminalContestant, runOpencodeTerminalContestant } from "@/arena/contestants/terminalContestants";
import { ArenaManagers, liveManagerSteps, type ManagerOpencodeBackend } from "@/arena/manager/arenaManagers";
import { config } from "@/config/config";

/**
 * The arena: one prompt fanned out to contestants in worktrees, made in the run's folder in the
 * arena home, of the repository the run names or of a new one the run gets of its own. Each
 * contestant is driven by its source's driver -- the sidecar's opencode backend, or a spawned
 * `claude --print` (ADR-0128) -- and the run records what each did. The runs it made are
 * reloaded from its store so a sidecar that restarts still lists them, and the contestants it
 * interrupted are picked back up from their panes, or failed saying why they cannot be.
 *
 * The terminals mode's drivers are wired only where there is a tmux to run them in; without one
 * the arena offers headless alone, and says so when a run asks for terminals. A run's manager lives
 * in a pane too, so it is wired only with them. A lane that names no model runs the configured one.
 * The manager is told this sidecar's own address, which it calls for its run.
 */
export function startArenaService(opencodeBackend: OpencodeContestantBackend & ManagerOpencodeBackend): ArenaService {
  const store = new ArenaStore(arenaRoot());
  const registry = new ArenaRunRegistry({
    initial: store.load(),
  });
  const managers = config.tmuxPath
    ? new ArenaManagers({
        registry,
        steps: liveManagerSteps(opencodeBackend, (runId, contestantId) =>
          store.readContestantDiff(runId, contestantId),
        ),
        claude: { model: arenaClaudeModel(), effort: arenaClaudeEffort() },
        api: `http://127.0.0.1:${config.port}`,
      })
    : null;
  const service = new ArenaService({
    registry,
    store,
    drivers: {
      opencode: (plan) => runOpencodeContestant(opencodeBackend, plan),
      claude: (plan) =>
        runClaudeContestant(plan, { model: plan.model ?? arenaClaudeModel(), effort: arenaClaudeEffort() }),
    },
    terminalDrivers: config.tmuxPath
      ? {
          opencode: (plan) => runOpencodeTerminalContestant(opencodeBackend, plan),
          claude: (plan) =>
            runClaudeTerminalContestant(plan, { model: plan.model ?? arenaClaudeModel(), effort: arenaClaudeEffort() }),
        }
      : null,
    managers,
    arenaHome: arenaHome(),
  });
  service.resumeInterruptedRuns();
  managers?.resume();
  return service;
}
