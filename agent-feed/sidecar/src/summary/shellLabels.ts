// One-line labels for shell tool calls that arrive without a description.
//
// Opencode records shell input as `{ command }` with no label of its own, so
// feed rows would otherwise carry the raw command -- a whole heredoc where a
// title should be. Claude rows keep their own `description` and never reach
// here. Deterministic by construction: no model, no network, no per-call
// cost, and secrets stay on this machine because values are redacted before
// anything is composed, never sent anywhere to be summarized.

const REDACTED = "[REDACTED]";

// consume one leading `export NAME=value;` or `NAME=value;` assignment.
function matchLeadingAssignment(src: string): number | null {
  const head = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.exec(src);
  if (!head) return null;
  let i = head[0].length;
  const quote = src[i];
  if (quote === "'" || quote === '"') {
    i += 1;
    while (i < src.length) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === quote) {
        i += 1;
        break;
      }
      i += 1;
    }
  } else {
    const start = i;
    while (i < src.length && src[i] !== ";" && src[i] !== "\n" && src[i] !== "|" && src[i] !== "&") i += 1;
    // A span with whitespace is shell's inline `VAR=val rest...` form, so
    // strip just the assignment and keep the rest. A span without is a pure
    // assignment covering the whole segment.
    const gap = src.slice(start, i).search(/\s/);
    if (gap >= 0) i = start + gap;
  }
  while (i < src.length && (src[i] === ";" || /\s/.test(src[i] ?? ""))) i += 1;
  return i;
}

// Leading env-setup assignments and `cd <path> &&` setup hops: agent
// transcripts are full of both, and the gist is always after them. A bare
// `cd` with nothing after it is left alone.
export function stripCommandPrefixes(cmd: string): string {
  let rest = cmd;
  for (;;) {
    const n = matchLeadingAssignment(rest);
    if (n === null || n <= 0) break;
    rest = rest.slice(n);
    if (rest.trim() === "") return "";
  }
  const hopped = rest.replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:&&|;)\s*/, "");
  if (hopped.trim() !== "") rest = hopped;
  return rest;
}

const SECRET_PATTERNS: RegExp[] = [
  // bearer / basic / named secret headers: -H "Authorization: Bearer VALUE".
  // The scheme group sits outside the prefix capture so the token redacts
  // with it instead of surviving beside the mask.
  /(-H\s+['"]?[\w.-]*(?:secret|token|api[_-]?key|authorization|auth|password|passwd)[\w.-]*:\s*)(?:(?:Bearer|Basic|Token)\s+)?([^\s'";]+)/gi,
  // key=value pairs: password=hunter2, --token abc123, "secret": "v"
  /((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?)([^\s'";,}]+)/gi,
  // cloudflare-style cfast_ tokens
  /\bcfast_[A-Za-z0-9_-]{16,}\b/g,
  // long quoted hex/blob ids: 'dea0cd84...f6c4.access'
  /(['"])[0-9a-fA-F]{24,}(?:\.[A-Za-z]+)?\1/g,
  // private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // JWT-shaped blobs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export function redactCommandSecrets(text: string): string {
  let out = text;
  // UPPER_SNAKE assignments with opaque values: CF_ID='...' (quoted 8+
  // chars or unquoted 12+; short values like DEBUG=1 are left alone).
  out = out.replace(
    /\b([A-Z][A-Z0-9_]{2,}=)(?:(['"])[^'"]{8,}\2|([^\s'";]{12,}))/g,
    (_match, name: string) => `${name}${REDACTED}`,
  );
  // mysql-style short password flag: -psecret, -p=secret (-p 8080 keeps port).
  out = out.replace(/(^|\s)(-p=?)([^\s;]+)/g, `$1$2${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      const groups = args.slice(1, -2);
      if (groups.length >= 2 && typeof groups[0] === "string") {
        return `${groups[0]}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

const VERBS: Record<string, string> = {
  grep: "Search",
  rg: "Search",
  ag: "Search",
  sed: "Read",
  cat: "Read",
  tail: "Show",
  head: "Show",
  less: "Read",
  ls: "List",
  find: "Find",
  du: "Show disk use of",
  df: "Show disk",
  ps: "List processes",
  git: "Git",
  docker: "Docker",
  npm: "npm",
  pnpm: "pnpm",
  bun: "Run",
  node: "Run",
  python3: "Run",
  curl: "Fetch",
  wget: "Fetch",
  ssh: "Run on host",
  chmod: "Make executable",
  mkdir: "Create directory",
  rm: "Remove",
  cp: "Copy",
  mv: "Move",
  tar: "Archive",
  rsync: "Sync",
  psql: "Query database",
  mysqldump: "Dump database",
  kubectl: "Kubernetes",
  cd: "Go to",
};

const GIT_SUBCOMMANDS: Record<string, string> = {
  status: "Show working tree status",
  log: "List commits",
  diff: "Show changes",
  push: "Push",
  pull: "Pull",
  commit: "Commit",
  show: "Show commit",
  branch: "List branches",
  stash: "Stash changes",
};

function splitTop(src: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (src.startsWith(sep, i)) {
      parts.push(cur);
      cur = "";
      i += sep.length - 1;
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function stageWords(stage: string): string[] {
  return stage.trim().split(/\s+/).filter(Boolean);
}

function firstPath(args: string[]): string | null {
  const hit = args.find(
    (arg) => /[/.]/.test(arg) && /[A-Za-z0-9]/.test(arg) && !arg.startsWith("-") && !arg.includes("$"),
  );
  return hit ? hit.replace(/['";,]+$/g, "") : null;
}

function baseName(path: string): string {
  const clean = path.replace(/[*?[\]{}]+/g, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

function clipToken(token: string): string {
  const clean = token.replace(/^['"]|['"]$/g, "");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}

// A grep pattern reads as syntax; the feed should read as words. Pipes
// become commas, escapes dissolve, anchors drop. Falls back to the raw
// pattern when nothing wordlike survives.
function prettifyPattern(pattern: string): string {
  let out = pattern.replace(/^['"]|['"]$/g, "");
  out = out.replace(/^\^/, "").replace(/\$$/, "");
  // Alternation reads as a list whether written `\|` or bare `|`.
  out = out
    .split(/\\?\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
  out = out.replace(/\\([.?*+()[\]{}|^$/\\])/g, "$1");
  out = out.replace(/\s+/g, " ").trim();
  return clipToken(out);
}

function hostOf(url: string): string {
  const match = url.replace(/^['"]|['"]$/g, "").match(/^https?:\/\/([^/]+)/);
  return match?.[1] ?? "URL";
}

function labelGit(args: string[]): string {
  const sub = args[0] ?? "";
  if (GIT_SUBCOMMANDS[sub]) {
    if (sub === "log") return "List commits";
    if (sub === "diff") {
      const path = firstPath(args.slice(1));
      return path ? `Show changes in ${baseName(path)}` : "Show changes";
    }
    return GIT_SUBCOMMANDS[sub] ?? "Git operation";
  }
  return "Git operation";
}

function labelStage(stage: string): string | null {
  let args = stageWords(stage);
  if (args.length === 0) return null;
  // Inline `VAR=x` prefixes mid-chain: the verb follows them.
  while (args.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? "")) args.shift();
  if (args.length === 0) return null;
  const verb = args[0] ?? "";
  const rest = args.slice(1);
  if (verb === "echo") return null; // section markers and bare echo are noise
  if (verb === "sleep") return null;
  // Shell keywords stage nothing on their own: `for`, `do`, and `done` wrap
  // the loop, the body inside carries the meaning.
  if (
    verb === "for" ||
    verb === "do" ||
    verb === "done" ||
    verb === "if" ||
    verb === "then" ||
    verb === "else" ||
    verb === "elif" ||
    verb === "fi" ||
    verb === "while" ||
    verb === "until" ||
    verb === "case" ||
    verb === "esac" ||
    verb === "time" ||
    verb === "coproc"
  ) {
    return null;
  }
  if (verb === "git") return labelGit(rest);
  if (verb === "grep" || verb === "rg" || verb === "ag") {
    // The full quoted span, not the first whitespace token: `"^check: | pass$"`
    // is one pattern, and splitting it loses every alternate after the space.
    const quoted = stage.match(/"([^"]+)"|'([^']+)'/);
    const rawPattern = quoted?.[1] ?? quoted?.[2] ?? rest.find((arg) => !arg.startsWith("-")) ?? "";
    const scope = rest.length > 1 ? (rest[rest.length - 1] ?? null) : null;
    const location = scope && /[/.]/.test(scope) ? ` in ${scope.replace(/^['"]|['"]$/g, "")}` : "";
    const pretty = rawPattern ? prettifyPattern(rawPattern) : "";
    return pretty ? `Search for ${pretty}${location}` : "Search code";
  }
  if (verb === "docker") {
    if (rest[0] === "ps") return "List running containers";
    if (rest[0] === "logs") return `Show logs for ${rest[1] ?? "container"}`;
    return `Docker ${rest[0] ?? "operation"}`;
  }
  if (verb === "curl" || verb === "wget") {
    const url = rest.find((arg) => /^https?:\/\//.test(arg.replace(/^['"]|['"]$/g, "")));
    return url ? `Fetch ${hostOf(url)}` : "Fetch URL";
  }
  if (verb === "cat" || verb === "sed" || verb === "tail" || verb === "head") {
    const path = firstPath(rest);
    const action = verb === "cat" || verb === "sed" ? "Read" : "Show";
    return path ? `${action} ${baseName(path)}` : `${action} output`;
  }
  if (verb === "ls") {
    const path = firstPath(rest);
    return path ? `List files in ${path}` : "List files";
  }
  if (verb === "psql") return "Query database";
  if (verb === "mysqldump") return "Dump database";
  if (verb === "chmod") return "Make executable";
  if (verb === "node" || verb === "bun") {
    const script = rest.find((arg) => /\.(m?[jt]s|tsx?)$/.test(arg));
    if (script) return `Run ${baseName(script)}`;
  }
  if (verb === "npx") {
    const tool = rest[0] ?? "";
    const spec = rest.find((arg) => /\.(test|spec)\.(m?[jt]s|tsx?)$/.test(arg));
    if (tool === "vitest" || tool === "jest" || tool === "mocha" || tool === "pytest") {
      return spec ? `Test ${baseName(spec)}` : `Test with ${tool}`;
    }
    if (tool === "tsc") return "Typecheck";
    const script = rest.find((arg) => /\.(m?[jt]s|tsx?)$/.test(arg));
    return script ? `Run ${baseName(script)}` : "Run command";
  }
  if (verb === "python3" && rest.includes("-")) return "Run script";
  const path = firstPath(rest);
  const name = VERBS[verb] ?? verb;
  return path ? `${name} ${baseName(path)}` : name;
}

function labelHeredoc(command: string): string {
  const match = command.match(/["']?([\w.-]+\.(?:ts|tsx|py|js|mjs|css|json|md))\b/);
  const file = match?.[1] ? baseName(match[1]) : null;
  if (/open\(|Path\(|read_text|io\.open/.test(command)) {
    return file ? `Edit ${file} with script` : "Edit file with script";
  }
  return file ? `Run script on ${file}` : "Run script";
}

// An unquoted `|` means a real pipeline. A `\|` inside quotes is grep
// alternation, not a stage boundary.
function hasPipe(chain: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < chain.length; i++) {
    const ch = chain[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "|") {
      return true;
    }
  }
  return false;
}

function labelChain(chain: string): string | null {
  if (/<<\s*['"]?(PY|EOF|SH)\b/.test(chain)) return labelHeredoc(chain);
  if (hasPipe(chain)) {
    const stages = splitTop(chain, "|")
      .map((part) => part.trim())
      .filter(Boolean);
    const significant = stages.filter((stage) => {
      const verb = stageWords(stage)[0];
      return verb !== "echo" && verb !== "sleep";
    });
    const last = significant[significant.length - 1] ?? "";
    const lastVerb = stageWords(last)[0];
    const sources = significant
      .slice(0, -1)
      .map(labelStage)
      .filter((label): label is string => label !== null);
    if (lastVerb === "head" || lastVerb === "tail") {
      // The line count adds nothing: agents pipe tail on nearly everything.
      // Name the stages feeding it instead; the tail itself says nothing.
      // A grep after a source is a filter stage, not the headline search.
      if (sources.length > 1) {
        const [first, ...rest] = sources;
        const filters = rest.map((label) => label.replace(/^Search for /, "filter for "));
        return [first, ...filters].slice(0, 3).join(", ");
      }
      if (sources.length > 0) return sources.slice(0, 3).join(", ");
      return labelStage(last);
    }
    if (lastVerb === "grep" || lastVerb === "rg") {
      const quoted = last.match(/"([^"]+)"|'([^']+)'/);
      const raw =
        quoted?.[1] ??
        quoted?.[2] ??
        stageWords(last)
          .filter((arg) => !arg.startsWith("-"))
          .slice(1)[0] ??
        "";
      const pretty = raw ? prettifyPattern(raw) : "";
      const filt = pretty ? `filter for ${pretty}` : "filter output";
      // The sink alone hides what flowed into it: name the source too.
      if (sources.length > 0) return `${sources.slice(0, 2).join(", ")}, ${filt}`;
      return pretty ? `Filter output for ${pretty}` : "Filter output";
    }
    if (lastVerb === "wc" || lastVerb === "sort" || lastVerb === "uniq") return "Summarize output";
    if (lastVerb === "tee") return "Save output";
    if (lastVerb === "xargs") return "Act on each result";
    if (lastVerb && /python3|node|bun/.test(lastVerb)) {
      const source = significant
        .slice(0, -1)
        .map(labelStage)
        .filter((label): label is string => label !== null)
        .pop();
      return source ? `${source}, parsed` : "Parse output";
    }
    const labeled = labelStage(last);
    if (labeled) return labeled;
    return labelStage(significant[0] ?? last);
  }
  return labelStage(chain);
}

// What an undescribed shell call did, as one line for the feed. Pure
// env-setup lines say so directly; anything else is verb plus object with
// secret values redacted out of the composed line.
export function heuristicShellLabel(rawCommand: string): string {
  const cleaned = stripCommandPrefixes(rawCommand).trim();
  if (cleaned === "") return "Set environment variables";
  const segments = splitTop(cleaned, "&&")
    .flatMap((part) => splitTop(part, ";"))
    .map((part) => part.trim())
    .filter(Boolean);
  const labels = segments.map(labelChain).filter((label): label is string => label !== null);
  const unique = [...new Set(labels)].slice(0, 3);
  if (unique.length === 0) return redactCommandSecrets(cleaned.split("\n")[0]?.slice(0, 80) ?? "");
  return redactCommandSecrets(unique.join(", "));
}
