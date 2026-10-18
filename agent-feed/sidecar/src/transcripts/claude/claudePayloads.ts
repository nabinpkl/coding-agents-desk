// What a Claude transcript line carries: the turn-boundary signal, the tool vocabulary
// its summaries are written in, the blocks a message's content becomes, and what its
// usage record says about tokens and the prompt cache.

import { COMPOSER_IMAGE_MEDIA_TYPES } from "@agentdesk/agent-feed-wire";
import { contextWindowFor } from "@/config/config";
import { cacheTtlFromUsage } from "@/cacheTtl";
import { toolFilePaths } from "@/transcripts/claude/claudeFiles";
import {
  TOOL_RESULT_PREVIEW_CAP,
  type ActivityBlock,
  type DeclaredModel,
  type EventCacheHit,
  type TokenUsage,
} from "@/transcripts/transcriptTypes";
import { basename } from "node:path";
import { plainBlock, stringifyForDisplay } from "@/transcripts/plainActivity";

/**
 * The turn-boundary signal a line carries, or undefined when it carries none.
 *
 * One home for the rule because two readers need it: `processLine`, which feeds
 * the transcript reads, and `readHeader`, which decides from a bounded tail read
 * whether a session's last turn is still open. Two copies would be free to
 * disagree about what "live" means, and both answers land on the same row.
 *
 * A user message OPENS a turn, which is what makes a resumed session live again.
 * An assistant message closes it only on `end_turn`. Every other record is silent
 * on the question, which is why the absent case is undefined and not `true`.
 */
export function turnClosedFor(ev: Record<string, unknown>): boolean | undefined {
  if (ev.type === "user") return false;
  if (ev.type !== "assistant") return undefined;
  const message =
    ev.message && typeof ev.message === "object" && !Array.isArray(ev.message)
      ? (ev.message as Record<string, unknown>)
      : {};
  return message.stop_reason === "end_turn";
}

export function truncate(s: string, n: number): string {
  const flat = s
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

// Input keys worth putting in a row label, most specific first. Consulted for any
// tool without a hand-written rule below, which before this list existed meant every
// tool but six -- `Skill` (42 calls here) and `Agent` (139) rendered with a blank
// label, because there was no fallback at all. The Codex adapter has always had one,
// which is why only Claude went blank.
const CLAUDE_SUMMARY_KEYS = [
  "skill",
  "description",
  "query",
  "url",
  "pattern",
  "command",
  "subject",
  "title",
  "path",
  "file_path",
  "prompt",
] as const;

// Per-tool summary string used as the row's chip label in the activity feed.
export function summarizeToolUse(name: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const path = typeof i.file_path === "string" ? i.file_path.split("/").pop() : null;
  if ((name === "Read" || name === "Edit" || name === "Write") && path) return `${name} ${path}`;
  if (name === "Bash" && typeof i.command === "string") return i.command.slice(0, 200);
  if (name === "Grep" && typeof i.pattern === "string") return `pattern "${i.pattern}"`;
  if (name === "Glob" && typeof i.pattern === "string") return i.pattern;
  for (const key of CLAUDE_SUMMARY_KEYS) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return `${name} ${value.trim().slice(0, 200)}`;
  }
  // A tool handed a LIST of files is about those files. `SendUserFile` is the one here, and the
  // only bare string it carries is `status`, so the fallback below labelled every one of them
  // `SendUserFile normal` -- a row that names the delivery mode and not what was delivered.
  if (Array.isArray(i.files)) {
    const names = (i.files as unknown[])
      .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
      .map((file) => basename(file));
    if (names.length) return `${name} ${names.join(", ")}`.slice(0, 200);
  }
  // Any string input at all beats a blank chip. Keys are read off the transcript, so
  // this walks the object's OWN entries rather than indexing by a name from it.
  for (const [key, value] of Object.entries(i)) {
    if (key && typeof value === "string" && value.trim()) {
      return `${name} ${value.trim().slice(0, 200)}`;
    }
  }
  return name;
}

// Arrow-prefixed snippet for the rail summary.
export function arrowToolUse(name: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const path = typeof i.file_path === "string" ? basename(i.file_path) : null;
  if (name === "Read" && path) return `→ Read ${path}`;
  if (name === "Edit" && path) return `→ Edit ${path}`;
  if (name === "Write" && path) return `→ Write ${path}`;
  if (name === "Bash" && typeof i.command === "string") return `→ Bash ${i.command}`;
  if (name === "Grep" && typeof i.pattern === "string") return `→ Grep "${i.pattern}"`;
  if (name === "Glob" && typeof i.pattern === "string") return `→ Glob ${i.pattern}`;
  if (name === "TodoWrite") return "→ TodoWrite";
  return `→ ${name}`;
}

export interface NormalizedClaudeBlock {
  block: ActivityBlock;
  raw: string | null;
  sidecarPath?: string;
}

/**
 * What a text-free tool result says, one line per item it carried.
 *
 * An MCP answer is often a list of `tool_reference` items whose `tool_name` IS the
 * content, so those are named; anything else contributes its own `type`, which keeps
 * a result from reading as empty when it held something. The whole record stays in
 * the Raw drawer either way -- this is the folded line, not the evidence.
 */
function nonTextResultPreview(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((item) =>
      typeof item?.tool_name === "string" ? item.tool_name : typeof item?.type === "string" ? item.type : "item",
    )
    .join("\n");
}

/**
 * The media type and base64 bytes of an image content block, or null when it is not one the panel
 * can be served.
 *
 * Only inline base64 in the API's own four types. The type is checked here, where the block is
 * made, because it later becomes a response's content-type on the panel's origin; anything else
 * stays a Plain block, whose Raw drawer still holds the whole record.
 */
function pastedImage(b: Record<string, unknown>): { mediaType: string; data: string } | null {
  const source = b.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { type, media_type: mediaType, data } = source as Record<string, unknown>;
  if (type !== "base64" || typeof data !== "string" || data.length === 0) return null;
  if (typeof mediaType !== "string") return null;
  if (!(COMPOSER_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) return null;
  return { mediaType, data };
}

export function normalizeBlocks(content: unknown): NormalizedClaudeBlock[] {
  if (typeof content === "string") {
    return content.trim()
      ? [{ block: { kind: "text", text: content }, raw: content }]
      : [{ block: plainBlock(content), raw: content }];
  }
  if (!Array.isArray(content)) {
    return [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
  }
  const out: NormalizedClaudeBlock[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    const t = b?.type;
    const image = t === "image" ? pastedImage(b) : null;
    if (t === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ block: { kind: "text", text: b.text }, raw: b.text });
    } else if (t === "thinking") {
      // Any `thinking` block is reasoning, even when its `thinking` text is
      // empty (an opaque encrypted `signature` trace). Classify by TYPE, not by
      // non-empty text: reading text here would dump the signature as a Plain
      // JSON card instead of an emittable collapsed reasoning block.
      const thinking = typeof b.thinking === "string" ? b.thinking : "";
      out.push({ block: { kind: "reasoning", text: thinking }, raw: thinking });
    } else if (t === "tool_use" && typeof b.name === "string") {
      const input = (b.input as Record<string, unknown> | undefined) ?? {};
      const id = typeof b.id === "string" ? b.id : undefined;
      // Resolved here rather than left to the reader, because the panel addresses one of these by
      // its POSITION and the route resolves that position from the same rule. See claudeFiles.ts.
      const files = toolFilePaths(input);
      out.push({
        block: {
          kind: "tool_use",
          tool: b.name,
          summary: summarizeToolUse(b.name, input),
          input,
          ...(files.length ? { files } : {}),
          ...(id ? { callId: id } : {}),
        },
        raw: null,
      });
    } else if (t === "tool_result") {
      let preview = "";
      const c = b.content;
      const useId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      const idPart = useId ? { callId: useId } : {};
      const items = Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
      // A screenshot a tool took, or a picture Read opened. Each becomes an image block right after
      // its result, named by the same call, for the reason a pasted one does: the bytes stay in the
      // line and the event carries only what kind of image is there.
      const returnedImages = items.flatMap((sub) => {
        const returned = sub?.type === "image" ? pastedImage(sub) : null;
        return returned ? [returned] : [];
      });
      if (typeof c === "string") preview = c;
      else if (Array.isArray(c)) {
        for (const sub of c as Array<Record<string, unknown>>) {
          if (sub?.type === "text" && typeof sub.text === "string") {
            preview = sub.text;
            break;
          }
        }
      }
      if (preview) {
        // Harness persisted the full output to a sidecar file. Mark the
        // block as truncated using the size hint in the envelope so the
        // Agent Panel can offer "Show full output" — extractBlockRaw will
        // then resolve the sidecar on demand.
        const persistedSize = parsePersistedSize(preview);
        if (persistedSize !== null && persistedSize > preview.length) {
          const sidecarPath = persistedOutputPath(preview);
          out.push({
            block: {
              kind: "tool_result",
              preview: preview.slice(0, TOOL_RESULT_PREVIEW_CAP),
              hiddenChars: persistedSize - preview.length,
              hiddenLines: 0,
              ...idPart,
            },
            raw: preview,
            ...(sidecarPath ? { sidecarPath } : {}),
          });
        } else if (preview.length > TOOL_RESULT_PREVIEW_CAP) {
          const kept = preview.slice(0, TOOL_RESULT_PREVIEW_CAP);
          const dropped = preview.slice(TOOL_RESULT_PREVIEW_CAP);
          out.push({
            block: {
              kind: "tool_result",
              preview: kept,
              hiddenChars: dropped.length,
              hiddenLines: (dropped.match(/\n/g) || []).length,
              ...idPart,
            },
            raw: preview,
          });
        } else {
          out.push({ block: { kind: "tool_result", preview, ...idPart }, raw: preview });
        }
      } else {
        // A result whose content carries no text at all: an MCP answer made of
        // `tool_reference` items, an image, a call that returned nothing. It is still
        // that call's result, and classifying it as anything else costs the READER
        // their own turn. Without a `callId` it pairs with no tool call, so it takes a
        // row of its own; and a user line holding neither text nor a result is exactly
        // what the feed draws as the person's message. Measured 2026-09-10 on a live
        // thread: every MCP call put a JSON envelope on screen as though it had been
        // typed by the reader, and the bar that names the current user turn read
        // "(no text)" instead of what they had actually written.
        // Images it returned are not named here: they are drawn, so a line reading "image" above
        // the picture would only repeat it.
        const unshown = Array.isArray(c) ? items.filter((sub) => !(sub?.type === "image" && pastedImage(sub))) : c;
        out.push({
          block: {
            kind: "tool_result",
            preview: nonTextResultPreview(unshown),
            ...idPart,
          },
          raw: stringifyForDisplay(b),
        });
      }
      for (const returned of returnedImages) {
        out.push({ block: { kind: "image", mediaType: returned.mediaType, ...idPart }, raw: returned.data });
      }
    } else if (image) {
      // A picture pasted into the prompt. Its bytes are the raw half, so `extractBlockRaw` hands
      // them to the image route and the event itself carries the media type alone. Before this it
      // fell through to Plain: sixty-odd kilobytes of base64 JSON on every page, drawn as a card.
      out.push({ block: { kind: "image", mediaType: image.mediaType }, raw: image.data });
    } else {
      const serialized = stringifyForDisplay(b);
      out.push({ block: plainBlock(b), raw: serialized });
    }
  }
  return out.length > 0 ? out : [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
}

// The harness stamps `<synthetic>` as the model on lines it injected itself.
// That is not a model switch and not an unknown model, so it must not resolve to
// a null window: the meter's merge carries the last real model and
// limit forward for any line that names no model.
const SYNTHETIC_MODEL = "<synthetic>";

export function assistantModel(message: Record<string, unknown>): string | undefined {
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!model || model === SYNTHETIC_MODEL) return undefined;
  return model;
}

// Pull total token occupancy off an assistant line. Sum of input +
// cache_creation + cache_read + output gives "what the model held in
// context at the end of this turn", which is what the Agent Panel meter
// shows. The first turn after a compaction reports a much smaller sum on its
// own, so there is no compaction-specific math here -- but there IS a
// compaction-specific reading, because that turn may be hours away:
// `extractCompactionUsage` above.
//
// Claude does not publish the context window in the transcript, so the limit is
// resolved HERE from the config table rather than left null for the panel to
// guess at. The model changes mid-session (13 of 129 sessions in this project),
// so it is read per line, not once per session.
export function extractClaudeUsage(usage: unknown, model: string | undefined, ts: number): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const current = input + cacheCreate + cacheRead + output;
  if (current <= 0) return null;
  const cacheTtlMs = cacheTtlFromUsage(u);
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
    ...(cacheTtlMs ? { cacheTtlMs } : {}),
  };
}

/**
 * The model this session is running, read off the harness's own declaration of it.
 *
 * The record is `{"type":"attachment","attachment":{"type":"model","identity":{"modelId":
 * "claude-opus-5[1m]","marketingName":"Opus 5 (1M context)",...}}}`, and where it lands is why
 * this is worth reading rather than guessing. Measured over this project's transcripts: a session
 * carries one near its top (line 11 to 29) AND one after every compaction -- 22 boundaries in the
 * largest file and 22 declarations, each arriving 13 to 16 lines after its boundary. Those are
 * exactly the two moments a context window has to be resolved.
 *
 * Present from CLI 2.1.265 onwards, and the cut is clean rather than patchy: of 346 transcripts
 * here, all 11 written by 2.1.265 or later carry one and none of the 335 older ones do. An older
 * session simply keeps resolving its window from `message.model`, which is what it did before.
 *
 * `cost-state.modelUsage` is keyed by the same full id and is NOT used, because it is written at
 * the last line of the file in 8 of the 10 largest sessions here: a correct answer that arrives
 * when the session is over.
 */
export function declaredModelIn(record: Record<string, unknown>): DeclaredModel | null {
  const attachment = record.attachment;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;
  const inner = attachment as Record<string, unknown>;
  if (inner.type !== "model") return null;
  const identity = inner.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const model = (identity as Record<string, unknown>).modelId;
  if (typeof model !== "string" || !model.trim()) return null;
  const id = model.trim();
  return { model: id, limit: contextWindowFor(id) };
}

/**
 * What the harness says the context holds AFTER it compacted, from the boundary record itself.
 *
 * The meter is otherwise fed only by assistant records, so nothing moves it until the next turn
 * runs. Measured over the 22 compactions in this project's largest session: the meter held the
 * pre-compaction number for a median of 356 seconds, and once for 8.4 hours, while the line two
 * records away already said what it had dropped to.
 *
 * Names no model, deliberately. The boundary record names none, and `mergeUsage` inherits the
 * limit and model from the last line that did -- the same path Codex `token_count` records and
 * Claude's `<synthetic>` lines take. A compaction before this session's first assistant line
 * (a resumed transcript opens that way) therefore shows a bare count until a turn names a model,
 * which is the existing rule for an occupancy report with no window rather than a new one.
 *
 * `postTokens` is NOT measured the same way as `preTokens`, and that is visible to the reader.
 * `preTokens` matched the meter's own last reading exactly at 16 of the 21 boundaries that had
 * one, and within 1000 at the rest -- so it counts the whole prompt. `postTokens` counts the
 * conversation only: after the newest compaction here it read 27,741 while the next prompt the
 * model actually processed was 109,079, the difference being the system prompt, the tool
 * definitions and the project instructions that the harness re-adds on the first turn. So the
 * meter drops to the conversation and climbs back once that overhead is re-sent. That is what
 * the number means rather than an error in it, and it is still the honest reading of the moment:
 * the alternative on offer is a number that is wrong by an entire compaction for six minutes.
 */
export function extractCompactionUsage(record: Record<string, unknown>, ts: number): TokenUsage | null {
  const metadata = record.compactMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const post = (metadata as Record<string, unknown>).postTokens;
  if (typeof post !== "number" || !Number.isFinite(post) || post <= 0) return null;
  return { current: post, limit: null, updatedAt: ts || Date.now() };
}

// Per-turn prompt-cache summary for the cache-hit badge. A "cache hit" for
// Claude is input served from the prompt cache (`cache_read_input_tokens`);
// `input` is the whole prompt, including the portion written to cache this
// turn (`cache_creation_input_tokens`), so the fraction reads as
// cache_read / (input + cache_read + cache_creation).
export function extractClaudeCacheHit(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const total = input + cacheCreate + cacheRead;
  if (total <= 0) return undefined;
  return { cached: cacheRead, input: total };
}

export function timestampMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Parse the `Output too large (43KB)` / `(2.1MB)` size hint inside a
// `<persisted-output>` envelope into an approximate char count, so the
// sidecar can stamp hiddenChars on the block. Returns null when the
// envelope is missing or the size is unparseable.
export function parsePersistedSize(raw: string): number | null {
  if (!raw.startsWith("<persisted-output>")) return null;
  const m = /Output too large \(([\d.]+)\s*([KMG]?B)\)/i.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "B").toUpperCase();
  const mult = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1;
  return Math.round(n * mult);
}

// Pull the sidecar path out of a `<persisted-output>` envelope. Format
// (verified empirically):
//   <persisted-output>
//   Output too large (43KB). Full output saved to: /abs/path/to/file.txt
//
//   Preview (first 2KB):
//   ...
// Returns the absolute path if the envelope matches, else null.
export function persistedOutputPath(raw: string): string | null {
  if (!raw.startsWith("<persisted-output>")) return null;
  const m = /Full output saved to:\s*(\S[^\n]*?)\s*(?:\n|$)/.exec(raw);
  const p = m?.[1]?.trim();
  return p && p.startsWith("/") ? p : null;
}

// Read the sidecar file, but only if it's under ~/.claude/projects. A
// transcript line is technically attacker-influenced (the harness writes
// what the model produces during a tool_result), so we refuse paths that
// resolve outside the projects tree. This is a defense in depth — the
// harness itself controls these writes today.
