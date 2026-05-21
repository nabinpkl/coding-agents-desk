---
name: project-signing-pivot
description: Apple Developer Program enrollment is throttled (~48hr+ ETA as of 2026-05-20). Dev-time signing pivots to Xcode free 7-day provisioning until enrollment lands. Notarized DMG and TestFlight acceptance items are gated on the real cert arriving.
metadata: 
  node_type: memory
  type: project
---

Apple Developer Program enrollment for AgentDesk submitted on or near 2026-05-20 and is throttled by Apple ("48 hours or more"). Until the paid cert lands, dev-time signing uses Xcode automatic free signing (7-day provisioning profile, reinstall via Xcode every 7 days, no TestFlight, no notarization).

**Why:** Apple-side throttle, not a user-side choice. The PRD's distribution model (Developer ID notarized DMG + TestFlight internal) remains the v0 target; the pivot is purely for unblocking pre-distribution work.

**How to apply:**
- For S0 (issue #2) and any work before the cert lands, treat "signed Developer ID `.app`" and "uploads to TestFlight successfully" as deferred acceptance items, not blockers. Dev installs the iOS app to a personally-owned device via Xcode Run.
- Reinstall cadence on the iPhone is every ~7 days during the pivot window. Note this in any handover doc that surfaces during this period.
- S1 through S7 implementation work can proceed against free signing; their acceptance criteria do not mention TestFlight or notarization, so they are not actually blocked.
- S8 (issue #10) stays HITL and remains the slice that converts dev-time signing to the real distribution path. When the cert lands, fold the deferred S0 acceptance items into S8 verification.
- If the throttle drags past a week, surface it as a real risk to the 7-day daily-driver test in [[project-v0-acceptance]] (the pivot reinstall cadence can collide with the daily-driver window).
