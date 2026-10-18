import { desktopDisplayId } from "@agentdesk/agent-feed-wire";

export interface DisplayCaptureTarget {
  key: string;
  displayId: string;
  captureId: number;
}
export class DisplayTargetUnavailable extends Error {
  constructor(
    readonly code: "display-unavailable" | "navigation-unavailable",
    readonly replacementDisplayId?: string,
  ) {
    super(code);
  }
}

/** Resolve aliases before touching the encoder cache; one physical display means one encoder. */
export async function resolveDisplayTarget(
  requested: string | undefined,
  read: () => Promise<Record<string, unknown>>,
): Promise<DisplayCaptureTarget> {
  const catalog = await read();
  if (catalog.available !== true || !Array.isArray(catalog.displays)) {
    throw new DisplayTargetUnavailable("navigation-unavailable");
  }
  const displays = catalog.displays.filter(
    (
      value,
    ): value is {
      id: string;
      isMain: boolean;
      captureId: number;
    } =>
      typeof value === "object" &&
      value !== null &&
      desktopDisplayId(value.id) &&
      typeof value.isMain === "boolean" &&
      Number.isInteger(value.captureId) &&
      value.captureId > 0 &&
      value.captureId <= 0xffffffff,
  );
  if (
    displays.length !== catalog.displays.length ||
    new Set(displays.map((display) => display.id)).size !== displays.length
  ) {
    throw new DisplayTargetUnavailable("navigation-unavailable");
  }
  const main = displays.find((display) => display.isMain) ?? displays[0];
  const selected = requested === undefined ? main : displays.find((display) => display.id === requested);
  if (!selected) throw new DisplayTargetUnavailable("display-unavailable", main?.id);
  return { key: `display:${selected.id}`, displayId: selected.id, captureId: selected.captureId };
}
