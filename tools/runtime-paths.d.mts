export interface RuntimePaths {
  root: string;
  gridEncoder: string;
  panelTlsDirectory: string;
  panelControlTokenFile: string;
  parkDevControlTokenFile: string;
  sidecarRegistry: string;
}

export function runtimePaths(
  environment?: Record<string, string | undefined>,
  homeDirectory?: string,
): RuntimePaths;

export function installedHostAppPath(bundleId: string, paths?: RuntimePaths): string;
