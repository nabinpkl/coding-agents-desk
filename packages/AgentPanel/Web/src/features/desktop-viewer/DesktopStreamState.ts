export type DesktopStreamState =
  | { kind: "connecting" }
  | { kind: "playing"; codec: string; firstFrameMs: number }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };
