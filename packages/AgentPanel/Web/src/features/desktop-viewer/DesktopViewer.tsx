"use client";

import { useCallback, useEffect, useState } from "react";
import type { DesktopDisplayResponse } from "@agentdesk/agent-feed-wire";
import { Hand, MousePointer2, RefreshCw } from "lucide-react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import { TileStreamRtc, type PointerInputTransport } from "./TileStreamRtc";
import { TileViewport } from "./TileViewport";

type DisplayState =
  | { kind: "loading" }
  | { kind: "ready"; display: DesktopDisplayResponse["display"] }
  | { kind: "error"; message: string };

function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim() !== "") return parsed.message;
  } catch {
    // The status below is still a complete, visible failure when the body is not JSON.
  }
  return body.trim() || `HTTP ${status}`;
}

function validDisplay(value: unknown): value is DesktopDisplayResponse {
  if (typeof value !== "object" || value === null) return false;
  const display = (value as { display?: unknown }).display;
  if (typeof display !== "object" || display === null) return false;
  if (typeof (display as { index?: unknown }).index !== "number") return false;
  const frame = (display as { frame?: unknown }).frame;
  if (typeof frame !== "object" || frame === null) return false;
  const candidate = frame as Record<"x" | "y" | "w" | "h", unknown>;
  const coordinatesValid = [candidate.x, candidate.y, candidate.w, candidate.h].every(
    (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate),
  );
  return coordinatesValid
    && typeof candidate.w === "number"
    && typeof candidate.h === "number"
    && candidate.w > 0
    && candidate.h > 0;
}

/** The whole Mac desktop, with no window inventory or Desktop Park controls. */
export function DesktopViewer({ transport }: { transport: AgentHttpTransport }) {
  const [display, setDisplay] = useState<DisplayState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [tile, setTile] = useState<DesktopStreamState>({ kind: "connecting" });
  const [pointerTransport, setPointerTransport] = useState<PointerInputTransport | null>(null);
  const [pointerMode, setPointerMode] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setDisplay({ kind: "loading" });
    void (async () => {
      try {
        const response = await transport.request(
          "GET",
          "/api/desktop/display",
          { signal: controller.signal },
        );
        if (response.status < 200 || response.status >= 300) {
          setDisplay({ kind: "error", message: errorMessage(response.body, response.status) });
          return;
        }
        const payload: unknown = JSON.parse(response.body);
        if (!validDisplay(payload)) throw new Error("desktop display response was invalid");
        setDisplay({ kind: "ready", display: payload.display });
      } catch (error) {
        if (!controller.signal.aborted) {
          setDisplay({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => controller.abort();
  }, [reload, transport]);

  const sendPointerInput = useCallback(
    (input: Parameters<PointerInputTransport["send"]>[0]) => pointerTransport?.send(input) ?? false,
    [pointerTransport],
  );

  if (display.kind !== "ready") {
    return (
      <main className="grid h-full place-items-center bg-black px-6 text-center text-white">
        <div className="space-y-3">
          <p className="font-mono text-xs text-white/70">
            {display.kind === "loading" ? "connecting to desktop…" : display.message}
          </p>
          {display.kind === "error" ? (
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
              className="mx-auto flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs
                text-white transition-colors hover:bg-white/15 active:bg-white/20
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Retry
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  const { frame } = display.display;
  const pointerReady = pointerTransport !== null && tile.kind === "playing";
  return (
    <main className="relative h-full overflow-hidden bg-black text-white">
      <TileViewport
        className="size-full"
        pointerMode={pointerMode}
        sendPointerInput={sendPointerInput}
      >
        <TileStreamRtc
          windowID="display"
          width={frame.w}
          height={frame.h}
          fill
          httpTransport={transport}
          onState={setTile}
          onPointerTransport={setPointerTransport}
        />
      </TileViewport>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between
        gap-3 bg-gradient-to-t from-black/65 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]
        pt-10">
        <p className="min-w-0 truncate font-mono text-[10px] text-white/70">
          {tile.kind === "playing" ? `${frame.w}×${frame.h} · ${tile.codec}` : tile.kind}
        </p>
        <div className="pointer-events-auto flex shrink-0 rounded-lg bg-black/60 p-1 backdrop-blur">
          <ModeButton
            active={!pointerMode}
            label="View"
            icon={<Hand className="size-3.5" aria-hidden />}
            onClick={() => setPointerMode(false)}
          />
          <ModeButton
            active={pointerMode}
            disabled={!pointerReady}
            label={pointerReady ? "Pointer" : "Input connecting"}
            icon={<MousePointer2 className="size-3.5" aria-hidden />}
            onClick={() => setPointerMode(true)}
          />
        </div>
      </div>
    </main>
  );
}

function ModeButton({
  active,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors
        focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white
        disabled:cursor-wait disabled:opacity-50
        ${active ? "bg-white text-black" : "text-white/75 hover:bg-white/10 active:bg-white/15"}`}
    >
      {icon}
      {label}
    </button>
  );
}
