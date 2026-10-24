# TASKS: deferred adaptive media-quality simulation

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

These tasks are deferred because the adaptive media quality ladder has landed and passed `just check`, but a repeatable simulator impairment harness is still tooling, not product behavior. The physical-device and simulator launch policy in `AGENTS.md` still applies: simulator and physical runs happen only on explicit user request.

Ordering:

- First prove the localhost QUIC traffic match with a dry run, because the simulator path uses `AGENTDESK_DEV_HOST_OVERRIDE=localhost` and must throttle loopback UDP `41888`, not Wi-Fi, Tailscale, or the offer port.
- Then add a bounded privileged harness, because real packet shaping requires `pfctl` and `dnctl` and must always clean up.
- Then add scripted profiles for slow, variable, and intermittent links, because profile churn should update dummynet pipes without rewriting PF rules.
- Add a no-sudo synthetic impairment mode only if repeatable automation matters more than real packet behavior.

## Deferred Tasks

- [ ] R112. Add a dry-run proof command or script that prints the active AgentDesk host listener, confirms UDP `41888` on loopback is the simulator session path, and validates the PF rule syntax without loading it.
- [ ] R113. Add a bounded `pfctl`/`dnctl` simulator throttle harness using the `com.apple/agentdesk-ladder` anchor, separate inbound/outbound pipes, `trap` cleanup, and no broad internet or Wi-Fi shaping.
- [ ] R114. Add named impairment profiles for clean, slow-link, lossy-link, intermittent-dropout, and variable-bandwidth runs by reconfiguring dummynet pipes live while the simulator session stays open.
- [ ] R115. Add log collection for ladder verification: host `owned-media` rung-change lines, host sent-frame `bitrateKbps` / `fps` / `resolutionScale`, capture restart lines, and simulator `/tmp/agentdesk-sim-console.log` media summaries.
- [ ] R116. Evaluate a dev-only no-sudo synthetic impairment mode for simulator automation. The mode should delay/drop media ACKs or link-health/control messages through explicit simulator environment variables, and it must be documented as a deterministic ladder exercise rather than real network shaping.

## Promotion Log

```
R112-R116   pending     deferred   adaptive media-quality simulator impairment harness and evidence collection
```
