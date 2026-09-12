import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ParkPlanResponse, ParkStateResponse } from "@agentdesk/agent-feed-wire";
import { DesktopParkPanel } from "@/features/desktop-park/DesktopParkModal";
import { groupByDesktop } from "@/features/desktop-park/desktopParkGroups";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";
import {
  FIRST_FRAME_TIMEOUT_MS,
  ICE_SETUP_TIMEOUT_MS,
  TileStreamRtc,
} from "@/features/desktop-viewer/tile-stream/TileStreamRtc";

const DISPLAY = { x: 0, y: 0, w: 1800, h: 1169 };

function state(overrides: Partial<ParkStateResponse> = {}): ParkStateResponse {
  return {
    yabaiPath: "/usr/local/bin/yabai",
    activeSpace: { index: 1, id: 3, display: 1 },
    displays: [{ index: 1, frame: DISPLAY }],
    stackingOrder: [11, 22],
    counts: { tracked: 4, parkable: 2, alreadyHere: 1, elsewhere: 1 },
    windows: [
      {
        id: 11, app: "ChatGPT", title: "Review latency", pid: 900, space: 1, display: 1,
        frame: { x: 100, y: 100, w: 600, h: 877 }, onActiveSpace: true, isVisible: true,
      },
      {
        id: 22, app: "Code", title: "evals", pid: 901, space: 4, display: 1,
        frame: { x: 20, y: 60, w: 900, h: 700 }, onActiveSpace: false, isVisible: false,
      },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<ParkPlanResponse> = {}): ParkPlanResponse {
  return {
    activeSpace: { index: 1, id: 3, display: 1 },
    display: { index: 1, frame: DISPLAY },
    options: { strip: 40, step: 24, topMargin: 39 },
    sound: true,
    overflow: [],
    starved: [],
    moves: [
      {
        id: 11, app: "ChatGPT", title: "Review latency", side: "right", depth: 0, rung: 0,
        from: { space: 1, x: 100, y: 100 }, to: { space: 1, x: 1760, y: 39 },
        exposedPt2: 35080, noop: false,
      },
      {
        id: 22, app: "Code", title: "evals", side: "left", depth: 1, rung: 0,
        from: { space: 4, x: 20, y: 60 }, to: { space: 1, x: -860, y: 39 },
        exposedPt2: 28000, noop: false,
      },
    ],
    ...overrides,
  };
}

function handle(overrides: Partial<DesktopParkHandle> = {}): DesktopParkHandle {
  return {
    available: true,
    view: { kind: "ready", state: state(), plan: plan() },
    action: { kind: "none" },
    load: () => {},
    park: () => {},
    restore: () => {},
    busy: false,
    ...overrides,
  };
}

describe("groupByDesktop", () => {
  it("puts the active Desktop first and the rest in index order", () => {
    const groups = groupByDesktop(
      state({
        activeSpace: { index: 4, id: 7, display: 1 },
        windows: [
          { ...state().windows[0]!, space: 6 },
          { ...state().windows[1]!, space: 4 },
        ],
      }),
    );
    expect(groups.map((g) => g.space)).toEqual([4, 6]);
    expect(groups[0]!.active).toBe(true);
  });

  it("returns nothing when there is no state yet, rather than an empty Desktop", () => {
    expect(groupByDesktop(undefined)).toEqual([]);
  });
});

describe("the Desktop park view", () => {
  it("groups windows under the Desktop they are on now", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    const active = screen.getByRole("heading", { name: /Desktop 1/ });
    expect(within(active).getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Desktop 4/ })).toBeInTheDocument();
    expect(screen.getByText("Review latency")).toBeInTheDocument();
  });

  it("shows where each window would land, so the move is legible before it happens", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    expect(screen.getByText("1760,39")).toBeInTheDocument();
    expect(screen.getByText("-860,39")).toBeInTheDocument();
  });

  it("refuses to park a plan that would starve a window", () => {
    const park = handle({
      view: { kind: "ready", state: state(), plan: plan({ sound: false, starved: [22] }) },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /^Park/ })).toBeDisabled();
    expect(screen.getByText(/stops rendering/)).toBeInTheDocument();
  });

  it("parks on demand and never on render", () => {
    const onPark = vi.fn();
    render(<DesktopParkPanel park={handle({ park: onPark })} onClose={() => {}} />);
    expect(onPark).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Park/ }));
    expect(onPark).toHaveBeenCalledOnce();
  });

  it("disables both actions while one is running", () => {
    const park = handle({ busy: true, action: { kind: "running", what: "park" } });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /Working/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore/ })).toBeDisabled();
  });

  it("says when the gather changed the stacking order the ladder was laid against", () => {
    const park = handle({
      action: {
        kind: "parked",
        report: {
          targetSpace: { index: 1, uuid: "u" },
          candidates: 2,
          gathered: [{ id: 11, app: "ChatGPT", ok: true }],
          orderBeforeGather: [11, 22],
          observedOrder: [22, 11],
          laid: [{ id: 11, app: "ChatGPT", ok: true }],
          sound: true,
          manifestPath: "/tmp/m.json",
          dryRun: false,
        },
      },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText(/stacking order changed during the gather/)).toBeInTheDocument();
  });

  it("reports a restore by outcome rather than claiming everything came back", () => {
    const park = handle({
      action: {
        kind: "restored",
        report: {
          found: true,
          parkedAt: 1,
          results: [
            { windowID: 11, app: "ChatGPT", outcome: "restored" },
            { windowID: 22, app: "Code", outcome: "orphaned", detail: "no window with this id" },
          ],
          manifestCleared: true,
        },
      },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText(/1 restored/)).toBeInTheDocument();
    expect(screen.getByText(/1 orphaned/)).toBeInTheDocument();
  });

  it("surfaces a sidecar failure instead of looking like it worked", () => {
    const park = handle({ view: { kind: "error", message: "no yabai binary found" } });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText("no yabai binary found")).toBeInTheDocument();
  });

  it("offers the whole desktop as a watchable source", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch desktop" }));
    // The tile section opens naming the display, and the toggle inverts.
    expect(screen.getByText(/the active Space/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop desktop" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop desktop" }));
    expect(screen.queryByText(/the active Space/)).not.toBeInTheDocument();
  });
});

describe("the WebRTC tile", () => {
  const originalFetch = globalThis.fetch;
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperties(globalThis, {
      fetch: { configurable: true, writable: true, value: originalFetch },
      RTCPeerConnection: {
        configurable: true,
        writable: true,
        value: originalPeerConnection,
      },
      crypto: { configurable: true, writable: true, value: originalCrypto },
    });
  });

  it("records receiver stats, times out stalled peers, and cleans up its timers", async () => {
    vi.useFakeTimers();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/telemetry")) return new Response(null, { status: 204 });
      return Response.json({
        type: "answer",
        sdp: "answer",
        codec: "h265",
        source: { width: 1800, height: 1169, cursor: { x: 900, y: 584 } },
      });
    }));

    class ConnectingPeer {
      static last: ConnectingPeer | undefined;
      localDescription: RTCSessionDescriptionInit | null = null;
      iceGatheringState: RTCIceGatheringState = "complete";
      iceConnectionState: RTCIceConnectionState = "checking";
      connectionState: RTCPeerConnectionState = "connecting";
      ontrack: RTCPeerConnection["ontrack"] = null;
      oniceconnectionstatechange: RTCPeerConnection["oniceconnectionstatechange"] = null;
      onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
      constructor() {
        ConnectingPeer.last = this;
      }
      createDataChannel(): RTCDataChannel {
        return {
          readyState: "connecting",
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
          onopen: null,
          onclose: null,
          onerror: null,
        } as unknown as RTCDataChannel;
      }
      addTransceiver() {}
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: "offer", sdp: "offer" };
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }
      async setRemoteDescription() {}
      async getStats(): Promise<RTCStatsReport> {
        return new Map<string, RTCStats>([
          ["inbound", {
            id: "inbound",
            type: "inbound-rtp",
            timestamp: 0,
            kind: "video",
            ssrc: 1,
            trackIdentifier: "video",
            packetsReceived: 120,
            bytesReceived: 12_000,
            packetsLost: 2,
            packetsRepaired: 1,
            packetsDiscarded: 3,
            jitter: 0.012,
            framesReceived: 60,
            framesDecoded: 58,
            framesDropped: 2,
            jitterBufferDelay: 1.16,
            jitterBufferTargetDelay: 2.32,
            jitterBufferEmittedCount: 58,
            totalDecodeTime: 0.58,
            nackCount: 4,
            pliCount: 1,
            decoderImplementation: "VideoToolbox",
            powerEfficientDecoder: true,
          } as RTCInboundRtpStreamStats],
          ["transport", {
            id: "transport",
            type: "transport",
            timestamp: 0,
            dtlsState: "connected",
            selectedCandidatePairId: "pair",
          } as RTCTransportStats],
          ["pair", {
            id: "pair",
            type: "candidate-pair",
            timestamp: 0,
            localCandidateId: "local",
            remoteCandidateId: "remote",
            state: "succeeded",
            nominated: true,
            bytesReceived: 12_000,
            bytesSent: 2_000,
            currentRoundTripTime: 0.08,
            availableIncomingBitrate: 1_500_000,
          } as RTCIceCandidatePairStats],
        ]) as RTCStatsReport;
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
      }
    }
    vi.stubGlobal("RTCPeerConnection", ConnectingPeer);
    vi.stubGlobal("crypto", { randomUUID: () => "test-attempt" });

    const { unmount } = render(
      <TileStreamRtc windowID="display" width={1800} height={1169} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_SETUP_TIMEOUT_MS);
    });

    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    expect(requests).toContainEqual({
      url: "/api/park/tile/display/webrtc/telemetry",
      body: {
        attempt: "test-attempt",
        phase: "setup-timeout",
        detail: "ice=checking connection=connecting",
        elapsedMs: ICE_SETUP_TIMEOUT_MS,
      },
    });
    unmount();

    requests.length = 0;
    const second = render(
      <TileStreamRtc windowID="display" width={1800} height={1169} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_SETUP_TIMEOUT_MS);
    });
    expect(requests.some(({ body }) => body.phase === "setup-timeout")).toBe(false);

    requests.length = 0;
    const third = render(
      <TileStreamRtc windowID="display" width={1800} height={1169} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const connected = document.querySelector("video");
    expect(connected).not.toBeNull();
    const active = ConnectingPeer.last;
    expect(active).toBeDefined();
    active!.connectionState = "connected";
    active!.iceConnectionState = "connected";
    const onConnectionStateChange = active!.onconnectionstatechange as ((event: Event) => void) | null;
    onConnectionStateChange?.(new Event("connectionstatechange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    });
    expect(requests.some(({ body }) => body.phase === "first-frame-timeout")).toBe(true);
    const receiverStats = requests.find(({ body }) => body.phase === "receiver-stats");
    expect(JSON.parse(String(receiverStats?.body.detail))).toMatchObject({
      event: "connection-connected",
      progress: "baseline",
      peer: {
        connection: "connected",
        ice: "connected",
      },
      inbound: {
        bytes: 12_000,
        packets: 120,
        lost: 2,
        repaired: 1,
        discarded: 3,
        jitterMs: 12,
        received: 60,
        decoded: 58,
        dropped: 2,
        jitterBufferMs: 20,
        jitterTargetMs: 40,
        decodeMs: 10,
        nack: 4,
        pli: 1,
        decoder: "VideoToolbox",
        powerEfficient: true,
      },
      path: {
        pair: "pair",
        state: "succeeded",
        nominated: true,
        bytesReceived: 12_000,
        bytesSent: 2_000,
        rttMs: 80,
        incomingKbps: 1500,
      },
    });
    third.unmount();

    const onState = vi.fn();
    const fourth = render(
      <TileStreamRtc
        windowID="display"
        width={1800}
        height={1169}
        onState={onState}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const playing = document.querySelector("video");
    expect(playing).not.toBeNull();
    act(() => playing!.dispatchEvent(new Event("loadeddata")));
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({
      kind: "playing",
      codec: "webrtc/h265",
    }));
    fourth.unmount();
  });
});
