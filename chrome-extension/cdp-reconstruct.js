// ADR-0044 Tier B: rebuild a self-contained projection HTML string from a CDP
// DOMSnapshot.captureSnapshot result. Shadow trees (open + closed) come flattened; computed styles
// are inlined per node so the snapshot renders WITHOUT external/adopted stylesheets; page scripts and
// author CSS are dropped. Ordinary content stays visible; password input values are masked here,
// BEFORE the snapshot leaves the extension (ADR-0041) because captureSnapshot returns raw values.
//
// Dual-mode: the service worker loads it via importScripts (top-level const/function share the worker
// realm, so worker.js can reference CDP_STYLE_PROPS + reconstructProjectionHtml); the cdp-verify test
// require()s it (module.exports below). No DOM is used, so it runs fine in both.

// Visually load-bearing computed styles, inlined per node. Kept focused to bound payload size.
const CDP_STYLE_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style', 'border-color', 'border-radius',
  'box-shadow', 'box-sizing', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space', 'vertical-align',
  'opacity', 'visibility', 'overflow', 'z-index',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'flex-grow', 'flex-shrink', 'flex-basis', 'gap',
  'grid-template-columns', 'grid-template-rows', 'object-fit', 'transform', 'list-style-type', 'cursor',
];
const CDP_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CDP_SKIP = new Set(['script', 'noscript', 'template', 'style', 'link']); // page CSS is replaced by inlined computed styles
const cdpEscAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const cdpEscText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cdpMaskPassword = (s) => String(s).replace(/\S/g, '*');
// Defense-in-depth: real DOMSnapshot tag/attribute names come from the browser's own machinery, but
// this string is documented as safe-for-egress HTML, so validate names (we escape values already).
// An invalid tag flattens to its children (content kept, no injected element); an invalid attribute
// name is dropped -- neither can break out of quoting or inject markup.
const CDP_NAME_OK = /^[a-zA-Z_:][\w:.-]*$/;

function reconstructProjectionHtml(snap) {
  const strings = (snap && snap.strings) || [];
  const doc = ((snap && snap.documents) || [])[0];
  if (!doc || !doc.nodes) return '<!doctype html><meta charset="utf-8">';
  const n = doc.nodes;
  const S = (idx) => (idx == null || idx < 0 || strings[idx] == null) ? '' : strings[idx];
  const parent = n.parentIndex || [];
  const nodeType = n.nodeType || [];
  const nodeName = n.nodeName || [];
  const nodeValue = n.nodeValue || [];
  const attributes = n.attributes || [];
  const count = parent.length;

  const children = Array.from({ length: count }, () => []);
  let root = 0;
  for (let i = 0; i < count; i++) { const p = parent[i]; if (p >= 0 && p < count) children[p].push(i); else root = i; }

  // RareStringData {index:[], value:[]} -> Map(nodeIndex -> stringIndex)
  const rareMap = (rare) => { const m = new Map(); if (rare && rare.index) for (let i = 0; i < rare.index.length; i++) m.set(rare.index[i], rare.value[i]); return m; };
  const inputValue = rareMap(n.inputValue);

  // Computed styles: layout.nodeIndex[] parallel to layout.styles[] (stringIndex per CDP_STYLE_PROPS).
  const styleByNode = new Map();
  const layout = doc.layout;
  if (layout && layout.nodeIndex) for (let i = 0; i < layout.nodeIndex.length; i++) styleByNode.set(layout.nodeIndex[i], layout.styles[i]);
  const styleAttr = (i) => {
    const s = styleByNode.get(i);
    if (!s || !s.length) return '';
    const decls = [];
    for (let k = 0; k < s.length && k < CDP_STYLE_PROPS.length; k++) { const v = S(s[k]); if (v) decls.push(CDP_STYLE_PROPS[k] + ':' + v); }
    return decls.length ? ' style="' + cdpEscAttr(decls.join(';')) + '"' : '';
  };

  const out = ['<!doctype html><meta charset="utf-8">'];
  const emit = (i) => {
    const t = nodeType[i];
    if (t === 3) { out.push(cdpEscText(S(nodeValue[i]))); return; }          // ordinary text -> visible
    if (t === 8 || t === 10) return;                                        // comment / doctype
    if (t === 9 || t === 11) { children[i].forEach(emit); return; }         // document / shadow fragment -> flatten
    if (t !== 1) return;                                                    // elements only
    const tag = (S(nodeName[i]) || 'div').toLowerCase();
    if (CDP_SKIP.has(tag)) return;
    if (!CDP_NAME_OK.test(tag)) { children[i].forEach(emit); return; }      // invalid tag -> flatten children
    let attrs = '';
    const a = attributes[i] || [];
    let inputType = '';
    for (let k = 0; k + 1 < a.length; k += 2) {
      if (S(a[k]).toLowerCase() === 'type') inputType = S(a[k + 1]).toLowerCase();
    }
    const isPassword = tag === 'input' && inputType === 'password';
    for (let k = 0; k + 1 < a.length; k += 2) {
      const name = S(a[k]);
      if (!name || /^on/i.test(name) || name.toLowerCase() === 'style' || !CDP_NAME_OK.test(name)) continue; // drop handlers, author inline style, malformed names
      let val = S(a[k + 1]);
      if (isPassword && name.toLowerCase() === 'value') val = cdpMaskPassword(val);
      attrs += ' ' + name + '="' + cdpEscAttr(val) + '"';
    }
    if (tag === 'input' || tag === 'textarea') {
      const iv = inputValue.has(i) ? S(inputValue.get(i)) : '';
      if (iv) attrs += ' value="' + cdpEscAttr(isPassword ? cdpMaskPassword(iv) : iv) + '"';
    }
    const open = '<' + tag + attrs + styleAttr(i) + '>';
    if (CDP_VOID.has(tag)) { out.push(open); return; }
    out.push(open);
    children[i].forEach(emit);
    out.push('</' + tag + '>');
  };
  emit(root);
  return out.join('');
}

// Node (cdp-verify test) only; skipped under importScripts (module is undefined in a worker).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reconstructProjectionHtml, CDP_STYLE_PROPS };
}
