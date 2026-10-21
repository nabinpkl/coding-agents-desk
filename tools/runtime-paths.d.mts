export interface RuntimePaths {
  root: string;
  gridEncoder: string;
  gridEncoderSlots: string;
  panelTlsDirectory: string;
  speechModels: string;
  panelPublishMode: string;
  sidecarRegistry: string;
  webrtcDiagLog: string;
  telemetryArchive: string;
}

export function runtimePaths(
  environment?: Record<string, string | undefined>,
  homeDirectory?: string,
): RuntimePaths;

export function installedHostAppPath(bundleId: string, paths?: RuntimePaths): string;
