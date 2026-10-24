# TASKS: v11 Agent Panel manual launch

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v10 Dock ledger through R103; v11 starts at R104 while independent live
verification checkpoints in earlier ledgers remain open.

## Position

The macOS Agent Panel is an explicit workspace command, so host launch prepares its controller without
presenting the window. Remove the obsolete auto-show configuration as one behavior path, preserve the
existing top-bar toggle as the sole presentation entry point, then verify the landed Release host.

## v11 Phase 1: manual presentation

- [x] D104. Remove `AGENTDESK_AGENTS_WINDOW_AUTOSHOW` from `tools/launch-env.sh` and
  `host/AgentDeskHost/Config.swift`, remove the launch-time `show()` call from
  `host/AgentDeskHost/AppDelegate.swift`, and cover the retired launcher variable plus lazy window
  construction in focused tests.
- [x] D105. Run the launch-environment test, focused Agent window tests, `git diff --check`, and
  `just check`; self-review the launch, explicit toggle, teardown, tests, and docs as one system.
- [ ] R106. After the required relaunch checkpoint, run the landed Release host, verify no Agents
  window exists through AX after launch, then open it through the top-bar command and verify its
  existing window identifier.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D104 | 2026-07-17 | done | Agent Panel launch is manual-only; the retired environment knob no longer reaches launchd or host configuration. |
| D105 | 2026-07-17 | done | Launcher regression, nine focused Agent window tests, all 534 host tests, diff hygiene, and self-review are green. |
| R106 | pending | pending | Release AX verification awaits the required host relaunch checkpoint. |
