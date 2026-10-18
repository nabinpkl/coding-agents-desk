// A file path an agent wrote in a message, made into a way to read that file.
//
// Agents name files constantly -- `src/app.ts:42` in inline code, a link to `docs/plan.md`, a bare
// `tools/check.sh` in a sentence -- and every one of them was dead text: a relative link even
// navigated the panel's new tab to a page that does not exist. Where a surface can open a file (a
// Bot's session card, whose Bot has a directory), it says so through `FilePathOpenerContext`, and
// the prose renderer marks every path that resolves inside that directory.
//
// Only paths INSIDE the root resolve. A relative path is read against it, an absolute one is kept
// only when it starts there, and `..` is refused outright: the sidecar would refuse it too, and a
// link that can only fail is worse than text.

import { createContext } from "react";
import { FENCE_SLOT_ATTRIBUTE } from "@/features/activity-feed/markdown/proseBlocks";

export interface FilePathTarget {
  /** Relative to the opener's root, `/`-separated, with no `.` or `..` components. */
  path: string;
  /** One-based, when the text named a line. */
  line: number | null;
}

export interface FilePathOpener {
  /** The absolute directory relative paths are read against. */
  root: string;
  open: (target: FilePathTarget) => void;
}

/** Absent everywhere a file cannot be opened, which leaves every path there as plain text. */
export const FilePathOpenerContext = createContext<FilePathOpener | null>(null);

/**
 * How sure the text is about being a path. A link's target was written AS an address, so a bare
 * `AGENTS.md` there is one. Inline code and prose are not: `origin/main` and `and/or` both have a
 * slash, so they need a directory AND a file name with an extension before they count.
 */
export type FilePathForm = "link" | "code";

const LINE_SUFFIX = /(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTENSION = /^[^.].*\.[A-Za-z0-9]{1,10}$|^\.[\w.-]+$/;

export function filePathTarget(text: string, root: string, form: FilePathForm): FilePathTarget | null {
  let value = text.trim();
  if (value === "" || /\s/.test(value)) return null;
  if (form === "link") {
    if (value.startsWith("file://")) value = value.slice("file://".length);
    else if (SCHEME.test(value) || value.startsWith("#")) return null;
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  const suffix = LINE_SUFFIX.exec(value);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : null;
  if (suffix) value = value.slice(0, suffix.index);
  if (value.startsWith("/")) {
    const base = `${root.replace(/\/+$/, "")}/`;
    if (!value.startsWith(base)) return null;
    value = value.slice(base.length);
  }
  while (value.startsWith("./")) value = value.slice(2);
  const components = value.split("/");
  if (components.some((part) => part === "" || part === "." || part === ".." || part === "~" || part === "@")) {
    return null;
  }
  const name = components[components.length - 1]!;
  if (form === "code" && (components.length < 2 || !EXTENSION.test(name))) return null;
  return { path: components.join("/"), line: line !== null && line > 0 ? line : null };
}

/** Marks an element as opening a file. Read back by `filePathAt`. */
export const FILE_PATH_ATTRIBUTE = "data-file-path";
const FILE_LINE_ATTRIBUTE = "data-file-line";

/**
 * A path with a directory and a file name, in running prose. Not after a word character, a slash,
 * a dot or a colon, which is what keeps it from starting in the middle of a URL or a longer token.
 */
const PROSE_PATH = /(?<![\w./:@~-])(?:\.\/|\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]+(?::\d+(?:[:-]\d+)?)?(?![\w/])/g;

/** Where a path is not: code blocks, existing links, a path already marked, a peeled fence. */
const NOT_PROSE = `pre, code, a, [${FILE_PATH_ATTRIBUTE}], [${FENCE_SLOT_ATTRIBUTE}]`;

function mark(node: Element, target: FilePathTarget): void {
  node.setAttribute(FILE_PATH_ATTRIBUTE, target.path);
  if (target.line !== null) node.setAttribute(FILE_LINE_ATTRIBUTE, String(target.line));
  node.setAttribute("role", "link");
  node.setAttribute("tabindex", "0");
  node.setAttribute("title", `Open ${target.path}${target.line === null ? "" : `:${target.line}`}`);
}

/**
 * Marks every path in `el` that resolves inside `root`: link targets, inline code, and paths in
 * running text, which are wrapped in a span of their own. Idempotent, so it can run again over
 * the same DOM.
 *
 * Returns whether it changed anything. A wrapped text node is no longer the node `applyProseHtml`
 * would extend, so the caller must replace rather than patch the next time.
 */
export function linkFilePaths(el: Element, root: string): boolean {
  let changed = false;
  for (const anchor of el.querySelectorAll(`a[href]:not([${FILE_PATH_ATTRIBUTE}])`)) {
    if (anchor.closest(`[${FENCE_SLOT_ATTRIBUTE}]`)) continue;
    const target = filePathTarget(anchor.getAttribute("href") ?? "", root, "link");
    if (target === null) continue;
    // The address would open the panel's own origin at a page that does not exist.
    anchor.removeAttribute("href");
    anchor.removeAttribute("target");
    mark(anchor, target);
    changed = true;
  }
  for (const code of el.querySelectorAll(`code:not([${FILE_PATH_ATTRIBUTE}])`)) {
    if (code.closest(`pre, a, [${FENCE_SLOT_ATTRIBUTE}]`)) continue;
    const target = filePathTarget(code.textContent ?? "", root, "code");
    if (target === null) continue;
    mark(code, target);
    changed = true;
  }
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(NOT_PROSE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) changed = wrapPaths(text, root) || changed;
  return changed;
}

function wrapPaths(text: Text, root: string): boolean {
  const data = text.data;
  const fragment = text.ownerDocument.createDocumentFragment();
  let from = 0;
  for (const match of data.matchAll(PROSE_PATH)) {
    const target = filePathTarget(match[0], root, "code");
    if (target === null) continue;
    if (match.index > from) fragment.append(data.slice(from, match.index));
    const span = text.ownerDocument.createElement("span");
    span.textContent = match[0];
    mark(span, target);
    fragment.append(span);
    from = match.index + match[0].length;
  }
  if (from === 0) return false;
  if (from < data.length) fragment.append(data.slice(from));
  text.replaceWith(fragment);
  return true;
}

/** The file a click or key landed on, if it landed on a marked path inside `within`. */
export function filePathAt(node: EventTarget | null, within: Element): FilePathTarget | null {
  if (!(node instanceof Element)) return null;
  const marked = node.closest(`[${FILE_PATH_ATTRIBUTE}]`);
  if (marked === null || !within.contains(marked)) return null;
  const line = marked.getAttribute(FILE_LINE_ATTRIBUTE);
  return { path: marked.getAttribute(FILE_PATH_ATTRIBUTE)!, line: line === null ? null : Number(line) };
}
