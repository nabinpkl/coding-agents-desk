import { ArenaRunRegistry, failUnfinishedContestants } from "@/arena/arenaRun";
import { ArenaService } from "@/arena/arenaService";
import { ArenaStore } from "@/arena/arenaStore";
import {
  arenaClaudeEffort,
  arenaClaudeModel,
  arenaDefaultRepoPath,
  arenaRoot,
} from "@/arena/arenaConfig";
import { runClaudeContestant } from "@/arena/claudeContestant";
import { runOpencodeContestant, type OpencodeContestantBackend } from "@/arena/opencodeContestant";

/**
 * The arena: one prompt fanned out to contestants in worktrees of any repo the run names. Each
 * contestant is driven by its source's driver -- the sidecar's opencode backend, or a spawned
 * `claude --print` (ADR-0128) -- and the run records what each did. The runs it made are
 * reloaded from its store so a sidecar that restarts still lists them, with the contestants a
 * restart orphaned marked failed rather than left reading as dueling forever.
 */
export function startArenaService(opencodeBackend: OpencodeContestantBackend): ArenaService {
  const store = new ArenaStore(arenaRoot());
  const registry = new ArenaRunRegistry({
    initial: failUnfinishedContestants(store.load()),
  });
  return new ArenaService({
    registry,
    store,
    drivers: {
      opencode: (plan) => runOpencodeContestant(opencodeBackend, plan),
      claude: (plan) =>
        runClaudeContestant(plan, { model: arenaClaudeModel(), effort: arenaClaudeEffort() }),
    },
    arenaRoot: arenaRoot(),
    defaultRepoPath: arenaDefaultRepoPath(),
  });
}
