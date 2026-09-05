export interface RuntimePaths {
  root: string;
  gridEncoder: string;
  gridEncoderSlots: string;
  panelTlsDirectory: string;
  panelControlTokenFile: string;
  parkDevControlTokenFile: string;
  sidecarRegistry: string;
  webrtcDiagLog: string;
}

export function runtimePaths(
  environment?: Record<string, string | undefined>,
  homeDirectory?: string,
): RuntimePaths;

export function installedHostAppPath(bundleId: string, paths?: RuntimePaths): string;
