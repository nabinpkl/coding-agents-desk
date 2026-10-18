import type { DesktopAuditSnapshot, DesktopWindow } from "@agentdesk/agent-feed-wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chain,
  claudeMainPids,
  desktopOwner,
  parseProcessTable,
  registryEntries,
  resolve,
  resumedSessionIds,
  resumePids,
  sessionOwner,
  target,
} from "@/desktop/claudeSessionResolver";

const CLAUDE_MAIN = "/Applications/Claude.app/Contents/MacOS/Claude";
const FLAG = "--resume";
const DESKTOP_SESSION = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e";
const TERMINAL_SESSION = "3e1b7a90-55cc-4d10-9f88-2b0c7d6a1e44";

/**
 * One tree carrying every shape at once, transcribed from a real `ps -axww` reading rather than
 * invented: a Desktop-owned session reached through Claude.app's `disclaimer` helper and spelling
 * its id `--resume=<id>`, a terminal session spelling it `--resume <id>`, and a session id that is a
 * strict prefix of the Desktop one.
 */
const FIXTURE = parseProcessTable(`
    1     0 /sbin/launchd
  400     1 ${CLAUDE_MAIN}
  410   400 /Applications/Claude.app/Contents/Helpers/disclaimer /Users/dev/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude --output-format stream-json
  420   410 /Users/dev/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude --output-format stream-json --permission-prompt-tool stdio --resume=${DESKTOP_SESSION}
  500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
  510   500 -zsh
  520   510 /Users/dev/.local/bin/claude --resume ${TERMINAL_SESSION} --model claude-opus-5
  600     1 ${CLAUDE_MAIN}
  610   600 /Users/dev/.local/bin/claude --resume=${DESKTOP_SESSION}-archived
`);

function resolveFixture(sessionId: string, rows = FIXTURE) {
  return resolve(sessionId, rows, CLAUDE_MAIN, FLAG);
}

/** The Claude main pid, or null when there is not exactly one. */
function ownerPid(sessionId: string, rows = FIXTURE): number | null {
  const owner = sessionOwner(resolveFixture(sessionId, rows));
  return typeof owner === "number" ? owner : null;
}

function ownerReason(sessionId: string, rows = FIXTURE): string | null {
  const owner = sessionOwner(resolveFixture(sessionId, rows));
  return typeof owner === "number" ? null : owner.reason;
}

function window(
  id: number,
  pid: number,
  spaceIDs: number[],
  { layer = 0, title = "Claude" }: { layer?: number; title?: string } = {},
): DesktopWindow {
  return {
    windowID: id,
    ownerPID: pid,
    ownerName: "Claude",
    title,
    spaceIDs: spaceIDs.map(String),
    layer,
    bounds: { x: 0, y: 0, w: 1200, h: 800 },
  };
}

function snapshot(
  activeSpaceID: number | null,
  windows: DesktopWindow[],
  {
    diagnostic = null,
    screenRecordingTrusted = true,
  }: {
    diagnostic?: string | null;
    screenRecordingTrusted?: boolean;
  } = {},
): DesktopAuditSnapshot {
  return {
    activeSpaceID: activeSpaceID === null ? null : String(activeSpaceID),
    desktops: [],
    windows,
    diagnostic,
    screenRecordingTrusted,
  };
}

/** A `~/.claude/sessions/<pid>.json` row in the shape Claude Code writes. */
function registryJSON(pid: number, sessionId: string, entrypoint: string | null = "claude-desktop"): string {
  const fields = [
    `"pid":${pid}`,
    `"sessionId":"${sessionId}"`,
    `"cwd":"/Users/dev/projects/agent-desk"`,
    `"startedAt":1786078983531`,
    `"kind":"interactive"`,
    ...(entrypoint === null ? [] : [`"entrypoint":"${entrypoint}"`]),
  ];
  return `{${fields.join(",")}}`;
}

/**
 * A live tree with one Desktop-owned session. The CLI argv carries no session id on purpose: a
 * brand-new session never names itself in argv, which is why the registry exists.
 */
function desktopChainRows(cliPid: number, claudeMainPid: number) {
  return parseProcessTable(`
    1     0 /sbin/launchd
   ${claudeMainPid}     1 ${CLAUDE_MAIN}
   ${cliPid + 1} ${claudeMainPid} /Applications/Claude.app/Contents/Helpers/disclaimer /Users/dev/claude --output-format stream-json
   ${cliPid} ${cliPid + 1} /Users/dev/claude --output-format stream-json --permission-prompt-tool stdio
`);
}

function registryDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "agentdesk-registry-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}

describe("process table", () => {
  test("parsing survives column padding and spaces in arguments", () => {
    expect(FIXTURE).toHaveLength(9);
    const helper = FIXTURE.find((row) => row.pid === 410);
    expect(helper?.parentPid).toBe(400);
    // Claude's embedded CLI lives under "Application Support", so the argument tail contains
    // spaces; rejoining after the two numeric columns must not lose them. The `--resume=` marker
    // sits at the very end of a real one of these lines, which is why the live reader passes -ww.
    expect(helper?.arguments).toContain("Application Support/Claude/claude-code");
    expect(parseProcessTable("")).toEqual([]);
    expect(parseProcessTable("garbage\n12 notapid args")).toEqual([]);
  });

  test("session matching is by whole token so a prefix does not steal the window", () => {
    expect(resumePids(DESKTOP_SESSION, FIXTURE, FLAG)).toEqual([420]);
    // pid 610 resumes "<desktopSession>-archived". A substring match would have returned it here
    // and resolved this session to the wrong Claude window.
    expect(resumePids(`${DESKTOP_SESSION}-archived`, FIXTURE, FLAG)).toEqual([610]);
    expect([...resumedSessionIds("claude --resume=abc --resume=def", FLAG)].sort()).toEqual(["abc", "def"]);
  });
});

describe("chain classification", () => {
  test("a Desktop chain resolves to the Claude main process", () => {
    const resolution = resolveFixture(DESKTOP_SESSION);

    expect(ownerPid(DESKTOP_SESSION)).toBe(400);
    expect(ownerReason(DESKTOP_SESSION)).toBeNull();
    expect(resolution.chains).toHaveLength(1);
    const link = resolution.chains[0]!;
    expect(link.kind).toBe("desktop");
    if (link.kind !== "desktop") return;
    expect(link.resumePid).toBe(420);
    expect(link.claudeMainPid).toBe(400);
    // Three real hops: the embedded CLI, Claude.app's disclaimer helper, Claude.app itself. These
    // strings are a log breadcrumb, not an identity -- the first is truncated at the space in
    // "Application Support", because argv arrives as one flat string with no way to tell an
    // argument boundary from a space in a path.
    expect(link.executables).toHaveLength(3);
    expect(link.executables[1]).toBe("/Applications/Claude.app/Contents/Helpers/disclaimer");
    expect(link.executables[2]).toBe(CLAUDE_MAIN);
  });

  test("a sibling binary whose name extends the main binary is not mistaken for it", () => {
    // ".../MacOS/ClaudeBeta" is a strict prefix extension of the configured main path. A bare
    // prefix test would stop here and hand back a pid that owns no Claude window.
    const rows = parseProcessTable(`
  800     1 ${CLAUDE_MAIN}Beta
  810   800 /bin/claude --resume=betaish
`);

    expect(ownerPid("betaish", rows)).toBeNull();
    expect(ownerReason("betaish", rows)).toBe("terminal-only");
  });

  test("a terminal chain is refused rather than offered a window", () => {
    const resolution = resolveFixture(TERMINAL_SESSION);

    expect(ownerPid(TERMINAL_SESSION)).toBeNull();
    expect(ownerReason(TERMINAL_SESSION)).toBe("terminal-only");
    expect(resolution.chains).toHaveLength(1);
    expect(resolution.chains[0]!.kind).toBe("terminal");
  });

  test("an absent session is not-running rather than terminal-only", () => {
    const sessionId = "00000000-0000-0000-0000-000000000000";
    expect(resolveFixture(sessionId).chains).toEqual([]);
    expect(ownerReason(sessionId)).toBe("not-running");
  });

  test("the Desktop chain wins when the same session is also resumed in a terminal", () => {
    const rows = parseProcessTable(`
    1     0 /sbin/launchd
  400     1 ${CLAUDE_MAIN}
  420   400 /Users/dev/claude --resume=${DESKTOP_SESSION}
  510     1 -zsh
  520   510 /Users/dev/.local/bin/claude --resume ${DESKTOP_SESSION}
`);

    expect(ownerPid(DESKTOP_SESSION, rows)).toBe(400);
  });

  test("two Claude instances holding one session is reported rather than tiebroken", () => {
    const rows = parseProcessTable(`
    1     0 /sbin/launchd
  400     1 ${CLAUDE_MAIN}
  420   400 /Users/dev/claude --resume=${DESKTOP_SESSION}
  600     1 ${CLAUDE_MAIN}
  620   600 /Users/dev/claude --resume=${DESKTOP_SESSION}
`);

    expect(claudeMainPids(resolveFixture(DESKTOP_SESSION, rows))).toEqual([400, 600]);
    expect(ownerPid(DESKTOP_SESSION, rows)).toBeNull();
    expect(ownerReason(DESKTOP_SESSION, rows)).toBe("multiple-instances");
  });

  test("several chains into one instance still resolve to that instance", () => {
    const rows = parseProcessTable(`
    1     0 /sbin/launchd
  400     1 ${CLAUDE_MAIN}
  420   400 /Users/dev/claude --resume=${DESKTOP_SESSION}
  430   400 /Users/dev/claude --resume=${DESKTOP_SESSION}
`);

    expect(claudeMainPids(resolveFixture(DESKTOP_SESSION, rows))).toEqual([400]);
    expect(ownerPid(DESKTOP_SESSION, rows)).toBe(400);
  });

  test("a cyclic parent chain terminates instead of spinning", () => {
    const rows = parseProcessTable(`
  700   710 /bin/a --resume=loopy
  710   700 /bin/b
`);

    expect(chain(700, rows, CLAUDE_MAIN).kind).toBe("terminal");
    expect(ownerReason("loopy", rows)).toBe("terminal-only");
  });
});

describe("registry resolver", () => {
  test("parsing tolerates the full observed schema", () => {
    // The live file carries pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, kind,
    // entrypoint, name, and nameSource. Decoding keeps what resolution needs and ignores the rest.
    const directory = registryDirectory({
      "90906.json":
        `{"pid":90906,"sessionId":"${DESKTOP_SESSION}","cwd":"/Users/dev/p",` +
        `"startedAt":1786078983531,"procStart":"Fri Aug  7 05:03:00 2026","version":"2.1.222",` +
        `"peerProtocol":1,"kind":"interactive","entrypoint":"claude-desktop","name":"agent-desk"}`,
    });

    const entries = registryEntries(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBe(90906);
    expect(entries[0]!.sessionId).toBe(DESKTOP_SESSION);
    expect(entries[0]!.entrypoint).toBe("claude-desktop");
  });

  test("a new Desktop session is resolved from its registry row", () => {
    const directory = registryDirectory({ "420.json": registryJSON(420, DESKTOP_SESSION) });
    const rows = desktopChainRows(420, 400);

    // The argv resolver alone cannot see this session at all -- that is the case the registry exists
    // for.
    expect(ownerPid(DESKTOP_SESSION, rows)).toBeNull();
    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBe(400);
  });

  test("a stale registry row whose pid is not in the live table is not live", () => {
    const directory = registryDirectory({ "999.json": registryJSON(999, DESKTOP_SESSION) });
    const rows = desktopChainRows(420, 400);

    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBeNull();
  });

  test("a terminal entrypoint registry row is not offered a window", () => {
    const directory = registryDirectory({ "420.json": registryJSON(420, DESKTOP_SESSION, "cli") });
    const rows = desktopChainRows(420, 400);

    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBeNull();
  });

  test("a registry row for another session does not resolve this one", () => {
    const directory = registryDirectory({ "420.json": registryJSON(420, TERMINAL_SESSION) });
    const rows = desktopChainRows(420, 400);

    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBeNull();
  });

  test("two registry rows into different instances are ambiguous rather than tiebroken", () => {
    const directory = registryDirectory({
      "420.json": registryJSON(420, DESKTOP_SESSION),
      "620.json": registryJSON(620, DESKTOP_SESSION),
    });
    const rows = [...desktopChainRows(420, 400), ...desktopChainRows(620, 600)];

    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBeNull();
  });

  test("unreadable registry files are skipped rather than poisoning the directory", () => {
    const directory = registryDirectory({
      "bad.json": "{not json",
      "notjson.txt": registryJSON(999, DESKTOP_SESSION),
      "420.json": registryJSON(420, DESKTOP_SESSION),
    });
    const rows = desktopChainRows(420, 400);

    expect(registryEntries(directory)).toHaveLength(1);
    expect(desktopOwner(DESKTOP_SESSION, rows, CLAUDE_MAIN, directory)).toBe(400);
  });

  test("a missing registry directory is empty rather than an exception", () => {
    expect(registryEntries("/nonexistent/agentdesk/sessions")).toEqual([]);
  });
});

describe("window targeting", () => {
  test("reports the window's home Desktop and whether it is already active", () => {
    const away = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [4])]));
    expect(away).toEqual({
      ok: true,
      target: {
        sessionId: DESKTOP_SESSION,
        claudeMainPid: 400,
        windowID: 42,
        homeSpaceID: "4",
        activeSpaceID: "1",
        bounds: { x: 0, y: 0, w: 1200, h: 800 },
        onActiveDesktop: false,
      },
    });

    const here = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [1])]));
    expect(here.ok && here.target.onActiveDesktop).toBe(true);
  });

  test("prefers the window already on the active Desktop", () => {
    const resolved = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [4]), window(43, 400, [1])]));

    expect(resolved.ok && resolved.target.windowID).toBe(43);
  });

  test("skips the untitled scaffolding windows Electron also owns", () => {
    // The bug this arc started from. One Claude Desktop instance was measured owning eight layer-0
    // windows; only the real browser window carries a title. Without the title filter the lowest
    // windowID scaffolding window on the ACTIVE Space wins, the target then reads as already on the
    // active Desktop so no move happens, and the real window keeps the collapsed accessibility tree
    // Chromium gives a window on another Space -- surfacing as "composer missing".
    const resolved = target(
      DESKTOP_SESSION,
      400,
      snapshot(1, [window(10, 400, [1], { title: "" }), window(11, 400, [1], { title: "" }), window(12, 400, [4])]),
    );

    expect(resolved.ok && resolved.target.windowID).toBe(12);
    expect(resolved.ok && resolved.target.onActiveDesktop).toBe(false);

    // Untitled alone is not a window at all, rather than a fallback.
    const only = target(DESKTOP_SESSION, 400, snapshot(1, [window(10, 400, [1], { title: "" })]));
    expect(only).toEqual({ ok: false, reason: "no-window" });
  });

  test("refuses windows that are not ordinary or not on exactly one Desktop", () => {
    const otherProcess = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 999, [1])]));
    expect(otherProcess).toEqual({ ok: false, reason: "no-window" });

    const panel = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [1], { layer: 3 })]));
    expect(panel).toEqual({ ok: false, reason: "no-window" });

    const everywhere = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [1, 2])]));
    expect(everywhere).toEqual({ ok: false, reason: "no-window" });

    const nowhere = target(DESKTOP_SESSION, 400, snapshot(1, [window(42, 400, [])]));
    expect(nowhere).toEqual({ ok: false, reason: "no-window" });
  });

  test("an unavailable Space authority fails loud rather than guessing a Desktop", () => {
    const noActive = target(DESKTOP_SESSION, 400, snapshot(null, [window(42, 400, [4])]));
    expect(noActive).toEqual({ ok: false, reason: "placement-unavailable" });

    const diagnosed = target(
      DESKTOP_SESSION,
      400,
      snapshot(1, [window(42, 400, [4])], { diagnostic: "SkyLight symbols unavailable" }),
    );
    expect(diagnosed).toEqual({ ok: false, reason: "placement-unavailable" });
  });

  test("a reader without Screen Recording refuses instead of seeing no titled windows", () => {
    // Without the grant every title is empty, which is indistinguishable from a Mac that genuinely
    // has no titled Claude window. Reporting "no-window" there would send the viewer looking for a
    // window that is open and visible in front of them.
    const blind = target(
      DESKTOP_SESSION,
      400,
      snapshot(1, [window(42, 400, [4], { title: "" })], { screenRecordingTrusted: false }),
    );
    expect(blind).toEqual({ ok: false, reason: "placement-unavailable" });
  });
});
