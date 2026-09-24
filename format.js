/* Shared Markdown brief builder. Loaded before content.js in the
 * extension and required by node tests. No DOM access here. */
(function (root) {
  function esc(s) {
    return String(s == null ? "" : s).replace(/`/g, "'");
  }

  function one(a, i) {
    var m = a.metadata || {};
    var lines = [];
    lines.push("## Feedback #" + (i + 1));
    lines.push("> " + esc(a.text));
    lines.push("");
    lines.push("- **Element:** `" + esc(m.tagName || "?") + "`");
    lines.push("- **Selector:** `" + esc(m.selector || "?") + "`");
    if (m.fullPath) lines.push("- **Path:** `" + esc(m.fullPath) + "`");
    if (m.classes) lines.push("- **Classes:** `" + esc(m.classes) + "`");
    if (m.text) lines.push("- **Text:** \"" + esc(String(m.text).slice(0, 200)) + "\"");
    if (m.component) lines.push("- **Component:** `" + esc(m.component) + "`");
    if (m.bbox) {
      var b = m.bbox;
      lines.push("- **Box:** x=" + b.x + " y=" + b.y + " w=" + b.width + " h=" + b.height);
    }
    if (m.styles) lines.push("- **Styles:** `" + esc(m.styles) + "`");
    if (m.tag) lines.push("- **Tag:** `" + esc(m.tag) + "`");
    return lines.join("\n");
  }

  function buildMarkdown(annotations, page) {
    var out = [];
    out.push("# Annotate Export");
    out.push("");
    out.push("**URL:** " + (page && page.url ? page.url : "unknown"));
    out.push("**Title:** " + (page && page.title ? esc(page.title) : "unknown"));
    out.push("**Items:** " + annotations.length);
    out.push("");
    annotations.forEach(function (a, i) {
      out.push(one(a, i));
      out.push("");
      out.push("---");
      out.push("");
    });
    return out.join("\n");
  }

  var api = { buildMarkdown: buildMarkdown };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.AnnotateExport = api;
  }
})(typeof self !== "undefined" ? self : this);
