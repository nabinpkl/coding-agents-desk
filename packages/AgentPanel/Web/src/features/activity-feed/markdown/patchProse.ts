// Applying a re-rendered Markdown block to the DOM without rebuilding it.
//
// The reveal hands this renderer a slightly longer document about thirty times a
// second, and `innerHTML =` is all-or-nothing: every node in the block is destroyed
// and recreated, so the styled boxes inside a streaming paragraph (inline code, a
// bolded span) are torn down and repainted on every tick, and any selection inside
// the message dies with them. Measured on a live thread: ~300 node mutations per
// second for one growing paragraph.
//
// But a reveal only ever appends to the end of the text. When the new HTML differs
// from the old one only in a run of characters at the end of its text content, the
// same DOM already has the right shape, and one text node needs a longer value.
// That is the common case by a wide margin; anything else (a marker closing, a new
// element, an entity) falls back to the full replacement.

/**
 * The trailing text edit that turns `previous` into `next`, or `null` when the
 * difference is anything else.
 *
 * Conservative on purpose: markup or an entity on either side of the edit, or any
 * text after it, means the block's structure may have changed, and the caller must
 * replace rather than patch. A wrong patch shows wrong text, so every uncertain
 * case is a `null`.
 */
export function trailingTextEdit(
  previous: string,
  next: string,
): { removed: string; added: string } | null {
  if (previous === "" || previous === next) return null;

  const shorter = Math.min(previous.length, next.length);
  let head = 0;
  while (head < shorter && previous[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < shorter - head &&
    previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }

  const removed = previous.slice(head, previous.length - tail);
  const added = next.slice(head, next.length - tail);
  // `<` or `>` means an element boundary moved; `&` means an entity, whose text
  // length does not match its markup length, so a text-node patch would be wrong.
  if (/[<>&]/.test(removed) || /[<>&]/.test(added)) return null;
  // Text after the edit means it did not land in the block's last text node, which
  // is the only node this can locate. Tags and the whitespace marked puts between
  // block elements do not count: neither is content, and prose blocks never carry a
  // `<pre>` (fences are peeled into their own component), so no trailing whitespace
  // here is significant.
  if (next.slice(next.length - tail).replace(/<[^>]*>/g, "").trim() !== "") return null;

  return { removed, added };
}

/** The last text node in `el` that carries content, ignoring inter-element whitespace. */
function lastContentTextNode(el: Element): Text | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim() !== "") last = text;
  }
  return last;
}

/**
 * Render `next` into `el`, extending the existing DOM when the only change is text
 * appended at the end and replacing it wholesale otherwise.
 *
 * `previous` is what this element was last given, which the caller tracks -- reading
 * `el.innerHTML` back would not do, because the browser reserializes it (attribute
 * order, entity spelling) and the comparison would never match.
 *
 * Both strings must already have been through `sanitizeProse`. This function moves
 * sanitized HTML into the document exactly as `dangerouslySetInnerHTML` did before
 * it; it is not a sanitization boundary and adds no new trust in the input.
 */
export function applyProseHtml(el: Element, previous: string, next: string): void {
  const edit = trailingTextEdit(previous, next);
  if (edit !== null) {
    const node = lastContentTextNode(el);
    if (node !== null && node.data.endsWith(edit.removed)) {
      node.data = node.data.slice(0, node.data.length - edit.removed.length) + edit.added;
      return;
    }
  }
  el.innerHTML = next;
}
