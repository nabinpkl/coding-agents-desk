/** Source geometry and cursor use the pointer helper's logical point coordinate space. */
export interface WebrtcTileSourceMetadata {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  /** The viewer keeps video alive when this is not the one supported control version. */
  desktopControlVersion: number;
  displayId?: string;
  desktopNavigationVersion?: number;
}

/** The one-round-trip WebRTC answer, including the encoder's authoritative source metadata. */
export interface WebrtcTileAnswer {
  type: "answer";
  sdp: string;
  codec: "h264" | "h265";
  source: WebrtcTileSourceMetadata;
}

export type DesktopCursorKind = "arrow" | "ibeam" | "pointingHand" | "resize" | "unknown";

/** Host cursor pixels and hotspot, emitted only when the WindowServer cursor seed changes. */
export interface WebrtcCursorImage {
  type: "cursor-image";
  hash: string;
  png?: string;
  hotspotXFrac: number;
  hotspotYFrac: number;
  widthPoints: number;
  heightPoints: number;
  hidden: boolean;
  cursorKind: DesktopCursorKind;
}

/** Independently observed Mac movement while remote pointer input is idle. */
export interface WebrtcCursorPosition {
  type: "cursor-position";
  x: number;
  y: number;
}

/** Native acknowledgement for one revisioned relative move after CGEvent.post. */
export interface WebrtcCursorApplied {
  type: "cursor-applied";
  revision: number;
  x: number;
  y: number;
}

export type WebrtcCursorEvent = WebrtcCursorApplied | WebrtcCursorImage | WebrtcCursorPosition;
