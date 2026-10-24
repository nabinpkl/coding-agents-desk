# TASKS: v0 owned single-surface media (with mixed-graphics escalation captured)

`R<N>` = remaining. Flip to `D<N>` once the change has landed and tests are green.

Archived history: `docs/tasks/archive/2026-06-19-v0-media-output-friction.md` carries the closed media-output exploration through the packet-repair slice.

## Position

The active media architecture is one owned QUIC surface carrying VideoToolbox encoded frames. Pairing, session authentication, the dedicated input WebSocket, Tailscale-only networking, Keychain state, Spaces input, cursor push, and host-local overlays stay in place.

Ordering:

- First remove the old media runtime branch, stale wire fields, and scroll-driven quality hints. They hide current behavior behind removed alternatives.
- Then keep packet repair as the first recovery action and skip stale delta frames when they miss the repair deadline.
- Then run the physical iPhone feel pass against the single path only. The logs should explain repair, stale-delta skip, keyframe fallback, render gaps, and admission lifecycle without any old path vocabulary.
- Then prevent one stale unacknowledged frame from closing host admission indefinitely. Stale ACKs are treated as congestion and admission pressure, not decoder recovery.
- Escalate to mixed graphics only after this owned full-frame path proves which text and motion gaps remain.

## v0 Phase 14 (R26): owned single-surface media cleanup

Phase goal: make the current source tree, tests, and docs expose one owned media path.

- [x] D26.1. Add ADR-0015 recording owned QUIC plus VideoToolbox as the current media architecture, superseding the earlier experimental media decisions without editing historical ADR conclusions.
- [x] D26.2. Replace active source contracts in `host/AgentDeskHost/MediaTransport.swift`, `client/AgentDeskClient/MediaTransport.swift`, `host/AgentDeskHost/SharedTypes.swift`, and `client/AgentDeskClient/SharedTypes.swift` with single-source and single-sink media types, remove runtime selection, and remove old media fields from `SessionReady`.
- [x] D26.3. Replace owned datagram packet metadata in `host/AgentDeskHost/OwnedMediaChannelServer.swift` and `client/AgentDeskClient/MediaTransport.swift` with `ADMD` v2 flags, where bit 0 marks keyframes and encoded-frame headers no longer carry a surface identifier.
- [x] D26.4. Remove scroll-driven media hints from `client/AgentDeskClient/GestureTranslator.swift`, `client/AgentDeskClient/PairingViewController+Gestures.swift`, `client/AgentDeskClient/InputChannel.swift`, `host/AgentDeskHost/InputChannelServer.swift`, and `host/AgentDeskHost/AppDelegate.swift`.
- [x] D26.5. Delete removed transport and renderer files, remove package references from both Xcode projects, and make `MediaStack` construct the owned transport and sink directly.
- [x] D26.6. Update host and client tests so they assert the owned-only session shape, `ADMD` v2 keyframe flags, exact resend replay, repair-before-deadline completion, stale delta skip, keyframe expiry fallback, and close-only session signaling.
- [x] D26.7. Update `PRD.md`, `SPEC.md`, `README.md`, `.env.example`, `Justfile`, and launcher tests so current docs and run commands describe the owned path only.
- [x] D26.8. Run `just check`, fix fallout, and keep the green cleanup ready for commit.
- [x] D26.9. Physical iPhone feel pass with `AGENTDESK_OWNED_MEDIA_CODEC=hevc AGENTDESK_OWNED_MEDIA_CHROMA=420 just fresh-consoled-run`, capture host and client logs, and show the freeze is host admission closing on stale unacknowledged frames rather than client decode or display enqueue.
- [x] D26.10. Change `client/AgentDeskClient/SharedTypes.swift`, `client/AgentDeskClient/OwnedMediaVideoSink.swift`, `host/AgentDeskHost/SharedTypes.swift`, and `host/AgentDeskHost/OwnedMediaTransport.swift` so healthy keyframes do not flush the display layer and stale unacknowledged host frames are visible in admission diagnostics.
- [x] D26.11. Change stale unacknowledged host frames from recovery-keyframe triggers into admission holds that abandon stale accounting while the raw capture mailbox coalesces newer frames.
- [x] D26.13. Add `AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN` and pre-encode frame scaling in `host/AgentDeskHost/OwnedMediaTransport.swift` so motion frames can reduce packet pressure while rest frames return to native capture.

---

## v0 mixed-graphics scope (captured, not started)

This scope opens only if R26.9 shows the single full-frame path still cannot keep text crisp at rest and motion current enough during scroll.

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Dirty-region refresh | RDP-style graphics remoting | Restores changed desktop areas without full-frame pressure | Region correctness and compositor ordering become product code |
| Scroll-copy command | Remote desktop screen-content model | Moves existing pixels immediately during scroll while new detail catches up | Breaks if the host app repaint diverges from predicted movement |
| Text/detail refresh | Mixed graphics model | Keeps code and terminal text crisp independent of motion compression | Requires detecting and painting desktop text without drifting from the host |
| Full-frame only | Current R26 path | Keeps the implementation small and measurable | May stay packet-heavy under fast desktop changes |

### Alternative arc (rejected for now, captured)

- Add a second visual surface. Rejected because R26 intentionally removes media-mode switching and old runtime seams before evaluating the owned path. Revisit only if R26.9 proves the one-surface path cannot satisfy both rest text and motion freshness.
- Return to a library-owned RTP stack. Rejected because the current ceiling question is receiver buffering, packet recovery, and VideoToolbox lifecycle control. Revisit only if maintaining QUIC media recovery becomes larger than replacing the stack.

## Promotion log

```
D26.1     2026-06-19  committed   ADR-0015 records owned single-surface media as current architecture
D26.2     2026-06-19  committed   media contracts and SessionReady remove old runtime selection fields
D26.3     2026-06-19  committed   ADMD v2 packet flags replace surface-tagged datagram metadata
D26.4     2026-06-19  committed   scroll-driven media quality hints removed from client and host
D26.5     2026-06-19  committed   removed transport files and package references deleted from active targets
D26.6     2026-06-19  committed   owned-only tests replace removed media-mode coverage
D26.7     2026-06-19  committed   current docs and run commands describe owned media only
D26.8     2026-06-19  committed   full check is green
D26.9     2026-06-19  committed   physical iPhone feel pass found host admission freeze on stale unacked frames
D26.10    2026-06-19  committed   healthy keyframes stop flushing and stale unacked frames became visible in admission diagnostics
D26.11    2026-06-19  committed   stale unacked frames hold admission instead of forcing recovery keyframes
D26.12    2026-06-19  committed   drain timeout reopens latest-frame admission instead of forcing recovery keyframes
D26.13    2026-06-20  committed   motion budget can downscale before VideoToolbox while rest returns to native capture
```
