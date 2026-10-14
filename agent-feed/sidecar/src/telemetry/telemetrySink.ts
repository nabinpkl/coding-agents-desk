// Where every telemetry envelope goes, whichever side made it: the archive on disk first, then a
// copy to Spotlight if one is running here.
//
// The panel's envelopes arrive through `telemetryRoutes.ts` and this process's own through the
// integration in `sidecarTelemetry.ts`; both land in this one function so the two sides cannot
// disagree about where telemetry lives.
//
// Telemetry must never take the sidecar down, so a failure here is reported and survived rather
// than thrown into the request or the SDK that produced it. Each failure is said once per change
// of state, not once per envelope, because the next envelope is a second away.

import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import { config } from "@/config/config";
import { TelemetryArchive, type TelemetrySource } from "@/telemetry/telemetryArchive";

const SPOTLIGHT_TIMEOUT_MS = 2000;

let archive: TelemetryArchive | null | undefined;
let archiveFailing = false;
let spotlightAnswering: boolean | undefined;

function openArchive(): TelemetryArchive | null {
  if (archive !== undefined) return archive;
  const directory = runtimePaths().telemetryArchive;
  // The archive makes its own directory. Not `ensureCrossSessionDirectory`, which opens up the
  // PARENT for every session: right for the shared logs directory, and wrong for a peer whose
  // archive is overridden into its own data root.
  try {
    archive = new TelemetryArchive(directory, config.telemetryArchiveBytes);
    console.log(`telemetry: archiving to ${directory} (cap ${config.telemetryArchiveBytes} bytes, ${archive.size} held)`);
  } catch (error) {
    // A machine without /Users/Shared and no override, or a disk that refuses: still forward to
    // Spotlight.
    archive = null;
    console.error(`telemetry: no archive at ${directory}, keeping nothing on disk:`, error);
  }
  return archive;
}

export function sinkEnvelope(source: TelemetrySource, envelope: string): void {
  const target = openArchive();
  if (target) {
    try {
      target.append(source, envelope);
      if (archiveFailing) console.log("telemetry: archive writing again");
      archiveFailing = false;
    } catch (error) {
      if (!archiveFailing) console.error("telemetry: archive write failed, dropping envelopes until it works:", error);
      archiveFailing = true;
    }
  }
  forwardToSpotlight(envelope);
}

function forwardToSpotlight(envelope: string): void {
  fetch(config.spotlightUrl, {
    method: "POST",
    body: envelope,
    headers: { "content-type": "application/x-sentry-envelope" },
    signal: AbortSignal.timeout(SPOTLIGHT_TIMEOUT_MS),
  }).then(
    (response) => noteSpotlight(response.ok, `answered ${response.status}`),
    (error: unknown) => noteSpotlight(false, String(error)),
  );
}

function noteSpotlight(answering: boolean, detail: string): void {
  if (answering === spotlightAnswering) return;
  spotlightAnswering = answering;
  console.log(answering
    ? `telemetry: Spotlight answering at ${config.spotlightUrl}`
    : `telemetry: Spotlight not answering at ${config.spotlightUrl} (${detail}); archive only`);
}
