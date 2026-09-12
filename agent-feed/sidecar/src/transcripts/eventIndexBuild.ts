// Reading a transcript file and turning it into an index: where each raw line starts,
// which raw lines the nice view keeps, and what a subscriber hears as they land.
//
// One build per session at a time. `indexBuilds` dedupes concurrent callers, and a file
// that shrank under us resets rather than being read against stale offsets.

import { stat } from "node:fs/promises";
import { state } from "./transcriptState.ts";
import { adapterFor } from "./sources/sourceAdapters.ts";
import { sessionKey } from "./transcriptCatalog.ts";
import { mergeUsage } from "./usageState.ts";
import type {
  ActivityEvent,
  LineClass,
  ParsedLine,
  SourceAdapter,
  TranscriptSourceId,
  TokenUsage,
} from "./sources/transcriptTypes.ts";
import { dropIndexState, niceInsertionPoint, INDEX_READ_BYTES } from "./eventIndexState.ts";

// Re-deliver a previously emitted event to the session's subscribers without
// touching the index. Used to upsert the cache-hit badge onto a turn's last
// content event after its `token_count` line reports the prompt usage: the
// badge line is machinery, so it never has an event of its own in the nice
// view, and re-notifying with the same id lets the panel replace the row.
function renotifyEvent(
  key: string,
  notice: { event: ActivityEvent; niceIndex: number | null },
): void {
  for (const subscriber of state.eventSubscribers.get(key) ?? []) {
    try {
      subscriber(notice);
    } catch (error) {
      console.error("agent feed event subscriber failed", error);
    }
  }
}

/**
 * Lines the replay guard below refused, per scan.
 *
 * Refusing a replayed line is normal and harmless. Refusing EVERY line of a scan that consumed
 * new bytes is not: it means this session will never emit again, because the guard compares
 * against an offset the scan can no longer get past. That is what a frozen transcript looks like
 * from in here, and without this counter it looks like nothing at all -- the case that had to be
 * diagnosed from a screenshot. Reset by `scanFrom` at the top of each pass.
 */
let guardRefusals = 0;

function emitParsedRaw(
  key: string,
  byteOffset: number,
  parsed: ParsedLine,
  lineClass: LineClass | undefined,
): { event: ActivityEvent; niceIndex: number | null } | null {
  let offsets = state.eventByteOffsets.get(key);
  if (!offsets) {
    offsets = [];
    state.eventByteOffsets.set(key, offsets);
  }
  const last = offsets.length > 0 ? offsets[offsets.length - 1]! : -1;
  if (byteOffset <= last) {
    guardRefusals += 1;
    return null;
  }
  let niceToRaw = state.niceToRaw.get(key);
  if (!niceToRaw) {
    niceToRaw = [];
    state.niceToRaw.set(key, niceToRaw);
  }
  const rawIndex = offsets.length;
  // Absent means content: the classifier's default, and the same default the raw
  // view applies, so an adapter that has not learned about a record type yet keeps
  // it visible in both.
  const isContent = lineClass !== "machinery";
  const niceIndex = isContent ? niceToRaw.length : null;
  offsets.push(byteOffset);
  if (isContent) niceToRaw.push(rawIndex);
  const event: ActivityEvent = {
    id: `${key}:line:${rawIndex}`,
    index: rawIndex,
    revision: 0,
    phase: "complete",
    otherModeIndex: niceIndex,
    ...parsed,
  };
  renotifyEvent(key, { event, niceIndex });
  return { event, niceIndex };
}

async function scanFrom(
  key: string,
  adapter: SourceAdapter,
  transcriptPath: string,
  startOffset: number,
  endOffset: number,
): Promise<number> {
  let cursor = startOffset;
  let carry = new Uint8Array();
  let carryStart = startOffset;
  const decoder = new TextDecoder();
  // The last content event emitted for this session, so a machinery line that
  // reports prompt usage (`token_count`) can hand its cache-hit badge to the
  // turn's last visible row. Replays keep this current too, which is harmless.
  //
  // Only events that carry a text block qualify. Codex emits `token_count`
  // between a response's tool calls and their results, so the immediately
  // preceding event is usually a tool row -- which the nice view folds into a
  // cluster that renders no badge. The assistant's prose row is the one a
  // viewer can actually see the badge on.
  let lastText: { event: ActivityEvent; niceIndex: number | null } | null = null;
  guardRefusals = 0;
  let emitted = 0;
  while (cursor < endOffset) {
    const chunkEnd = Math.min(endOffset, cursor + INDEX_READ_BYTES);
    const chunk = await Bun.file(transcriptPath).slice(cursor, chunkEnd).bytes();
    const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
    combined.set(carry, 0);
    combined.set(chunk, carry.byteLength);
    let lineStart = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 0x0a) continue;
      if (index > lineStart) {
        const line = decoder.decode(combined.subarray(lineStart, index));
        const result = adapter.processLine(line);
        // Folded BEFORE the event is emitted, so a live subscriber reading the
        // session's occupancy while handling this event sees the value this very
        // line reported rather than the previous one. Replaying an already
        // indexed line is harmless: the merge overwrites `current`, it does not
        // accumulate.
        if (result?.usage) {
          state.sessionUsage.set(
            key,
            mergeUsage(state.sessionUsage.get(key), result.usage),
          );
        }
        if (result?.event) {
          const isContent = result.lineClass !== "machinery";
          // A line that reports cache usage owns the badge on the event it
          // emits: content lines (Claude assistant usage) show it in both
          // views, and codex `token_count` rows show it in the raw view that
          // renders them. The nice view reads it off the re-stamped text row.
          if (result.cacheHit) result.event.cacheHit = result.cacheHit;
          const notice = emitParsedRaw(key, carryStart + lineStart, result.event, result.lineClass);
          if (notice) {
            emitted += 1;
            if (isContent && result.event.blocks.some((block) => block.kind === "text")) {
              lastText = notice;
            } else if (result.cacheHit && lastText) {
              // Codex `token_count`: the badge also belongs on the turn's last
              // prose row, which was already emitted. Re-notify with the same
              // id so the panel upserts the badge onto it. The revision bumps
              // so the panel's upsert filter (newer revision wins) accepts the
              // badge exactly like the live mirror's cache re-stamp does.
              lastText.event.revision += 1;
              lastText.event.cacheHit = result.cacheHit;
              renotifyEvent(key, lastText);
            }
          }
        }
      }
      lineStart = index + 1;
    }
    carry = combined.slice(lineStart);
    carryStart += lineStart;
    cursor = chunkEnd;
  }
  if (emitted === 0 && guardRefusals > 0) {
    // Every line this pass read was refused as a replay. The session is not idle, it is stuck:
    // its recorded offsets are ahead of where the scan is reading from, and no later pass can
    // get past them either. Says so rather than returning quietly.
    console.error(JSON.stringify({
      event: "agent-feed-index-scan-emitted-nothing",
      key,
      startOffset,
      endOffset,
      refused: guardRefusals,
      lastIndexedOffset: state.eventByteOffsets.get(key)?.at(-1) ?? null,
    }));
  }
  return carryStart;
}

async function buildOrSyncIndex(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const key = sessionKey(source, sessionId);
  const inflight = state.indexBuilds.get(key);
  if (inflight) {
    // Joining the running build is not enough on its own: it measured the file when
    // it started, so anything appended since is outside the pass this caller is
    // about to await. Ask it for another look before it settles. Without this the
    // caller returns an index that stops short of the change it was told about, and
    // waits for a filesystem event that already happened.
    state.indexResyncs.add(key);
    await inflight;
    return;
  }
  const build = (async () => {
    // Re-measures on each pass. The flag is cleared at the top so a request arriving
    // DURING a pass schedules the next one rather than being cleared by it.
    do {
      state.indexResyncs.delete(key);
      let metadata: Awaited<ReturnType<typeof stat>>;
      try {
        metadata = await stat(transcriptPath);
      } catch (error) {
        // A transcript that cannot be measured cannot be followed, and returning quietly here
        // freezes the session's stream with nothing to explain it. Raised so the follower's
        // `onError` reports it, exactly like a watcher failure.
        throw new Error(`failed to stat transcript for ${key}`, { cause: error });
      }
      let startOffset = state.indexedSizes.get(key) ?? 0;
      if (metadata.size < startOffset) {
        dropIndexState(key, { keepBuild: true });
        startOffset = 0;
      }
      if (metadata.size > startOffset) {
        const adapter = adapterFor(source);
        const committed = await scanFrom(
          key,
          adapter,
          transcriptPath,
          startOffset,
          metadata.size,
        );
        state.indexedSizes.set(key, committed);
      }
      state.indexed.add(key);
    } while (state.indexResyncs.has(key));
  })();
  state.indexBuilds.set(key, build);
  try {
    await build;
  } finally {
    // Only this build's own entry. A drop that ran mid-flight can have cleared it and let a
    // successor register, and deleting that successor's entry would open the same gap again.
    if (state.indexBuilds.get(key) === build) {
      state.indexBuilds.delete(key);
      state.indexResyncs.delete(key);
    }
  }
}

export async function ensureIndexed(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}

export async function syncIndex(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}
