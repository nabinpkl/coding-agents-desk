/* v0 content script: hover highlight, click container, comment, list, export.
 * UI lives in Shadow DOM so page styles never leak in or out. */
(function () {
  if (window.__annotateExportLoaded) return;
  window.__annotateExportLoaded = true;
  console.log("[annotate-export] content loaded v0.1.1");

  var active = false;
  var annotations = [];
  var seq = 0;
  var hoverEl = null;
  var host = null;
  var root = null;
  var dimEl = null;
  var boxEl = null;

  var BLOCK = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BUTTON: 1, CARD: 1,
    DD: 1, DETAILS: 1, DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1,
    FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1,
    H4: 1, H5: 1, H6: 1, HEADER: 1, INPUT: 1, LI: 1, MAIN: 1, NAV: 1,
    OL: 1, P: 1, SECTION: 1, SELECT: 1, TABLE: 1, TD: 1, TEXTAREA: 1,
    TH: 1, TR: 1, UL: 1
  };

  function inUI(el) {
    return !!(el && el.closest && el.closest("[data-ax-ui]")) || (host && host.contains(el));
  }

  function pickContainer(el) {
    if (!el || el === document.body || el === document.documentElement) return el;
    var tag = el.tagName;
    if (BLOCK[tag]) return el;
    var p = el.parentElement;
    while (p && p !== document.body) {
      if (BLOCK[p.tagName]) return p;
      p = p.parentElement;
    }
    return el;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return "?";
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 4) {
      var part = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        var cls = cur.className.trim().split(/\s+/).filter(function (c) {
          return c && c.length < 30 && !/^(ng-|css-|emotion|styled)/.test(c);
        }).slice(0, 2).map(cssEscape).join(".");
        if (cls) part += "." + cls;
      }
      var sib = cur.parentElement ? Array.prototype.filter.call(cur.parentElement.children, function (c) {
        return c.tagName === cur.tagName;
      }) : [];
      if (sib.length > 1) part += ":nth-of-type(" + (sib.indexOf(cur) + 1) + ")";
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function fullPath(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      parts.unshift(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function componentName(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.getAttribute) {
        var comp = cur.getAttribute("data-component") || cur.getAttribute("data-testid") || cur.getAttribute("data-cy");
        if (comp) return comp;
        for (var i = 0; i < cur.attributes.length; i++) {
          var n = cur.attributes[i].name;
          if (/^data-(component|react|vue|ng)/.test(n)) return n + "=" + cur.attributes[i].value;
        }
      }
      cur = cur.parentElement;
    }
    return "";
  }

  function styleSummary(el) {
    try {
      var cs = getComputedStyle(el);
      return ["color:" + cs.color, "bg:" + cs.backgroundColor, "font:" + cs.fontSize,
        "pad:" + cs.padding, "border:" + cs.border].join(" ");
    } catch (e) {
      return "";
    }
  }

  function ensureUI() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-ax-ui", "1");
    host.id = "__annotate_export_host";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "open" });
    var st = document.createElement("style");
    st.textContent = ".ax-bar,.ax-list,.ax-form{color-scheme:light dark;--ax-bg:rgba(255,255,255,.88);--ax-fg:#1d1d1f;--ax-muted:#6e6e73;--ax-border:rgba(0,0,0,.12);--ax-accent:#007aff;--ax-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--ax-sans:-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,'Segoe UI',sans-serif}" +
      "@media (prefers-color-scheme:dark){.ax-bar,.ax-list,.ax-form{--ax-bg:rgba(30,30,32,.86);--ax-fg:#f5f5f7;--ax-muted:#98989f;--ax-border:rgba(255,255,255,.16);--ax-accent:#0a84ff}}" +
      ".ax-bar{position:fixed;z-index:2147483647;top:12px;right:12px;display:flex;gap:6px;align-items:center;background:var(--ax-bg);color:var(--ax-fg);font:13px/1.4 var(--ax-sans);padding:7px 7px 7px 12px;border:1px solid var(--ax-border);border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.25);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}" +
      ".ax-bar strong{font-weight:600}" +
      ".ax-btn{background:transparent;color:var(--ax-fg);border:1px solid var(--ax-border);border-radius:8px;padding:4px 10px;font:12px var(--ax-sans);cursor:pointer}" +
      ".ax-btn:hover{background:rgba(127,127,127,.18)}" +
      ".ax-count{background:#c00;color:#fff;border-radius:10px;min-width:20px;text-align:center;font-size:12px;font-weight:600}" +
      ".ax-dot{font-size:10px;color:#999}" +
      ".ax-list{position:fixed;z-index:2147483647;top:62px;right:12px;width:300px;max-height:44vh;overflow:auto;background:var(--ax-bg);color:var(--ax-fg);font:12px/1.5 var(--ax-sans);border:1px solid var(--ax-border);border-radius:14px;padding:6px;box-shadow:0 4px 20px rgba(0,0,0,.25);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}" +
      ".ax-item{padding:7px 9px;border-radius:9px;border-left:3px solid #c00;cursor:pointer;margin:2px 0}" +
      ".ax-item:hover{background:rgba(127,127,127,.16)}" +
      ".ax-bug{border-left-color:#ff453a}.ax-suggestion{border-left-color:#30d158}.ax-question{border-left-color:#ffd60a}" +
      ".ax-top{display:flex;gap:6px;align-items:center}" +
      ".ax-top span{flex:1}" +
      ".ax-reply{margin:1px 0 1px 16px;font-size:11px;color:var(--ax-muted)}" +
      ".ax-thumb{width:120px;border-radius:8px;cursor:zoom-in;margin:2px 0 2px 16px;display:block;border:1px solid var(--ax-border)}" +
      ".ax-light{position:fixed;inset:0;z-index:2147483649;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out}" +
      ".ax-light[hidden]{display:none}" +
      ".ax-light img{max-width:92vw;max-height:92vh;border-radius:12px}" +
      ".ax-replybox{display:flex;gap:6px;margin:2px 0 2px 16px}" +
      ".ax-replybox input{flex:1;font:12px var(--ax-sans);color:var(--ax-fg);background:rgba(127,127,127,.14);border:1px solid var(--ax-border);border-radius:7px;padding:4px 7px}" +
      ".ax-replybox input:focus{outline:none;border-color:var(--ax-accent)}" +
      ".ax-done span{text-decoration:line-through;opacity:.55}" +
      ".ax-mini{background:transparent;border:1px solid var(--ax-border);border-radius:6px;color:var(--ax-muted);cursor:pointer;font-size:11px;padding:0 6px}" +
      ".ax-mini:hover{color:var(--ax-fg)}" +
      ".ax-form{position:fixed;z-index:2147483648;left:50%;top:16%;transform:translateX(-50%);width:380px;max-width:92vw;background:var(--ax-bg);color:var(--ax-fg);font:13px/1.5 var(--ax-sans);border:1px solid var(--ax-border);border-radius:16px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}" +
      ".ax-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}" +
      ".ax-head strong{font-size:13px;font-weight:600}" +
      ".ax-x{background:transparent;border:0;color:var(--ax-muted);font-size:14px;cursor:pointer;border-radius:6px;padding:0 6px}" +
      ".ax-x:hover{color:var(--ax-fg)}" +
      ".ax-sel{font:11px/1.5 var(--ax-mono);color:var(--ax-muted);margin-bottom:8px;word-break:break-all;max-height:44px;overflow:hidden}" +
      ".ax-form textarea{width:100%;box-sizing:border-box;font:13px/1.5 var(--ax-sans);color:var(--ax-fg);background:rgba(127,127,127,.14);border:1px solid var(--ax-border);border-radius:10px;padding:8px;resize:vertical}" +
      ".ax-form textarea:focus{outline:none;border-color:var(--ax-accent);box-shadow:0 0 0 3px rgba(0,122,255,.25)}" +
      ".ax-row{display:flex;gap:8px;margin-top:10px;align-items:center}" +
      ".ax-row select{font:12px var(--ax-sans);color:var(--ax-fg);background:transparent;border:1px solid var(--ax-border);border-radius:8px;padding:5px 6px}" +
      ".ax-spacer{flex:1}" +
      ".ax-primary{background:var(--ax-accent);color:#fff;border:0;border-radius:9px;padding:6px 14px;font:13px var(--ax-sans);font-weight:600;cursor:pointer}" +
      ".ax-btn.ax-on{background:var(--ax-accent);color:#fff;border-color:transparent}" +
      ".ax-ghost{background:transparent;color:var(--ax-fg);border:1px solid var(--ax-border);border-radius:9px;padding:6px 12px;font:13px var(--ax-sans);cursor:pointer}";
    root.appendChild(st);
    root.innerHTML +=
      '<div class="ax-bar" data-ax-ui="1">' +
      '<strong>Annotate</strong><span class="ax-count">0</span><span class="ax-dot" title="agent bridge">●</span>' +
      '<button class="ax-btn" data-act="mode">Mode: Element</button>' +
      '<button class="ax-btn" data-act="copy">Copy</button>' +
      '<button class="ax-btn" data-act="download">.md</button>' +
      '<button class="ax-btn" data-act="hide">List</button>' +
      '<button class="ax-btn" data-act="clear">Clear</button>' +
      '<button class="ax-btn" data-act="off">Off</button>' +
      "</div>" +
      '<div class="ax-list" data-ax-ui="1"></div>' +
      '<div class="ax-form" data-ax-ui="1" hidden>' +
      '<div class="ax-head"><strong>Annotate container</strong><button class="ax-x" data-act="cancel">✕</button></div>' +
      '<div class="ax-sel"></div>' +
      '<textarea rows="4" placeholder="What is wrong with this container?"></textarea>' +
      '<div class="ax-row"><select><option value="bug">bug</option>' +
      '<option value="suggestion">suggestion</option>' +
      '<option value="question">question</option></select>' +
      '<span class="ax-spacer"></span>' +
      '<button class="ax-ghost" data-act="cancel">Cancel</button>' +
      '<button class="ax-primary" data-act="save">Save</button></div>' +
      "</div>";
    root.querySelector(".ax-bar").addEventListener("click", onBar);
    root.querySelector(".ax-form").addEventListener("click", onForm);
    root.querySelector(".ax-list").addEventListener("click", onLocate);
    var lb = document.createElement("div");
    lb.className = "ax-light";
    lb.hidden = true;
    lb.addEventListener("click", function () { lb.hidden = true; });
    root.appendChild(lb);
    try {
      var bld = (typeof window !== "undefined" && window.AX_BUILD) || null;
      if (bld) root.querySelector(".ax-bar").title = "build " + bld.sha + " · v" + bld.version + " · " + bld.at;
    } catch (e) { /* stamp missing */ }
  }

  function render() {
    if (!root) return;
    root.querySelector(".ax-count").textContent = String(annotations.length);
    var dot = root.querySelector(".ax-dot");
    if (dot) dot.style.color = bridge === true ? "#3fb950" : (bridge === false ? "#f00" : "#999");
    var modeBtn = root.querySelector('[data-act="mode"]');
    if (modeBtn) {
      modeBtn.textContent = shotMode ? "Mode: Shot" : "Mode: Element";
      modeBtn.className = shotMode ? "ax-btn ax-on" : "ax-btn";
    }
    var list = root.querySelector(".ax-list");
    list.innerHTML = "";
    if (bridge === false) {
      var warn = document.createElement("div");
      warn.className = "ax-item";
      warn.textContent = "Bridge offline: items stay in this tab only.";
      list.appendChild(warn);
    }
    if (!annotations.length) {
      var empty = document.createElement("div");
      empty.className = "ax-item";
      empty.textContent = "No annotations yet. Click a container.";
      list.appendChild(empty);
    }
    annotations.forEach(function (a, i) {
      var tag = (a.metadata && a.metadata.tag) || "bug";
      var doneState = a.status === "resolved";
      var who = doneState ? " ✓ " + (a.resolvedBy || "?") : "";
      if (a.metadata && a.metadata.screenshot === "failed") who += " shot failed, see console";
      else if (a.metadata && a.metadata.screenshot) who += " 📷";
      var d = document.createElement("div");
      d.className = "ax-item ax-" + tag + (doneState ? " ax-done" : "");
      d.setAttribute("data-idx", String(i));
      var top = document.createElement("div");
      top.className = "ax-top";
      var label = document.createElement("span");
      label.textContent = (i + 1) + ". [" + tag + "] " + a.text + who;
      var doneBtn = document.createElement("button");
      doneBtn.className = "ax-mini";
      doneBtn.setAttribute("data-op", doneState ? "reopen" : "done");
      doneBtn.textContent = doneState ? "↩" : "✓";
      doneBtn.title = doneState ? "reopen" : "mark done";
      var delBtn = document.createElement("button");
      delBtn.className = "ax-mini";
      delBtn.setAttribute("data-op", "del");
      delBtn.textContent = "✕";
      delBtn.title = "remove";
      var replyBtn = document.createElement("button");
      replyBtn.className = "ax-mini";
      replyBtn.setAttribute("data-op", "reply");
      replyBtn.textContent = "↪";
      replyBtn.title = "reply";
      var shotBtn = document.createElement("button");
      shotBtn.className = "ax-mini";
      shotBtn.setAttribute("data-op", "shot");
      shotBtn.textContent = "📷";
      shotBtn.title = "screenshot element";
      d.appendChild(top);
      top.appendChild(label);
      top.appendChild(doneBtn);
      top.appendChild(delBtn);
      top.appendChild(replyBtn);
      top.appendChild(shotBtn);
      (a.replies || []).forEach(function (rp) {
        var rd = document.createElement("div");
        rd.className = "ax-reply";
        rd.textContent = (rp.by || "?") + ": " + (rp.text || "");
        d.appendChild(rd);
      });
      var shot = a.metadata && a.metadata.screenshot;
      if (shot && shot !== "pending" && shot !== "failed") {
        var im = document.createElement("img");
        im.className = "ax-thumb";
        im.src = BRIDGE + "/shot/" + encodeURIComponent(shot);
        im.title = "click to enlarge";
        im.onerror = function () { im.remove(); };
        d.appendChild(im);
      }
      list.appendChild(d);
    });
    drawMarkers();
    try {
      chrome.runtime.sendMessage({ type: "ANNOTATE_COUNT", count: annotations.length });
    } catch (e) { /* no background in some pages */ }
  }

  function drawMarkers() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-ax-marker]"), function (n) {
      n.remove();
    });
    annotations.forEach(function (a, i) {
      var el = null;
      try { el = document.querySelector(a.metadata.selector); } catch (e) { el = null; }
      if (!el) return;
      var r = el.getBoundingClientRect();
      var m = document.createElement("div");
      m.setAttribute("data-ax-marker", "1");
      m.textContent = String(i + 1);
      var tagColors = { bug: "#c00", suggestion: "#1a7f37", question: "#b7791f" };
      var mc = tagColors[(a.metadata && a.metadata.tag) || "bug"] || "#c00";
      m.style.cssText = "position:fixed;z-index:2147483646;left:" + r.left +
        "px;top:" + (r.top - 22) + "px;background:" + mc + ";color:#fff;" +
        "font:12px/20px sans-serif;min-width:20px;text-align:center;border-radius:10px;pointer-events:none;";
      document.body.appendChild(m);
    });
  }

  var pending = null;
  var shotMode = false;
  var pendingShot = null;
  var bridge = null; // null unknown, true ok, false offline
  var BRIDGE = "http://127.0.0.1:3847";

  function openForm(el) {
    ensureUI();
    pending = el;
    var f = root.querySelector(".ax-form");
    f.hidden = false;
    f.querySelector(".ax-sel").textContent = selectorFor(el) + (pendingShot ? " + 📷 shot armed" : "");
    var ta = f.querySelector("textarea");
    ta.value = "";
    setTimeout(function () { ta.focus(); }, 0);
  }

  function closeForm() {
    pending = null;
    pendingShot = null;
    if (root) {
      root.querySelector(".ax-form").hidden = true;
    }
  }

  function onBar(e) {
    var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
    if (!act) return;
    if (act === "off") setActive(false);
    if (act === "mode") { shotMode = !shotMode; render(); }
    if (act === "hide") {
      var l = root.querySelector(".ax-list");
      l.style.display = l.style.display === "none" ? "block" : "none";
    }
    if (act === "clear") {
      if (!window.confirm("Remove all listed annotations from this tab and the server store?")) return;
      annotations = [];
      render();
      if (!window.fetch) return;
      fetch(BRIDGE + "/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.href })
      }).then(function (r) {
        bridge = !!r.ok;
        render();
      }).catch(function () { bridge = false; render(); });
    }
    if (act === "copy") copyBrief();
    if (act === "download") downloadBrief();
  }

  function onForm(e) {
    var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
    if (!act) return;
    if (act === "cancel") closeForm();
    if (act === "save") {
      var ta = root.querySelector("textarea");
      var sel = root.querySelector("select");
      var text = ta.value.trim();
      if (!text || !pending) { closeForm(); return; }
      var el = pending;
      var r = el.getBoundingClientRect();
      seq += 1;
      var rec = {
        id: seq,
        status: "open",
        resolvedBy: null,
        replies: [],
        text: text,
        metadata: {
          tagName: el.tagName,
          selector: selectorFor(el),
          fullPath: fullPath(el),
          classes: (el.className && typeof el.className === "string") ? el.className.trim().slice(0, 200) : "",
          text: (el.innerText || el.textContent || "").trim().slice(0, 200),
          component: componentName(el),
          bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          styles: styleSummary(el),
          tag: sel.value
        }
      };
      annotations.push(rec);
      if (pendingShot) {
        var shot = pendingShot;
        pendingShot = null;
        saveWithShot(rec, shot);
      } else {
        postAnnotation(rec);
      }
      closeForm();
      render();
    }
  }

  function brief() {
    var api = (typeof self !== "undefined" && self.AnnotateExport) || null;
    var page = { url: location.href, title: document.title };
    if (api) return api.buildMarkdown(annotations, page);
    return "# Annotate Export\n\nNo items.";
  }

  function copyBrief() {
    var text = brief();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* clipboard blocked */ }
    ta.remove();
  }

  function downloadBrief() {
    var blob = new Blob([brief()], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "annotate-brief.md";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function onLocate(e) {
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.target && e.target.tagName === "IMG") {
      var lb = root.querySelector(".ax-light");
      if (lb) {
        lb.innerHTML = "";
        var big = document.createElement("img");
        big.src = e.target.src;
        lb.appendChild(big);
        lb.hidden = false;
      }
      return;
    }
    var opEl = e.target && e.target.closest ? e.target.closest("[data-op]") : null;
    var t = e.target && e.target.closest ? e.target.closest("[data-idx]") : null;
    if (!t) return;
    var a = annotations[Number(t.getAttribute("data-idx"))];
    if (!a) return;
    if (opEl) {
      var op = opEl.getAttribute("data-op");
      if (op === "del") deleteRec(a);
      else if (op === "done") setRecStatus(a, "resolved");
      else if (op === "reopen") setRecStatus(a, "open");
      else if (op === "reply") showReplyBox(t, a);
      else if (op === "send") sendReplyBox(t, a);
      else if (op === "shot") shootRec(a);
      return;
    }
    var el = null;
    try { el = document.querySelector(a.metadata.selector); } catch (err) { el = null; }
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    var old = el.style.outline;
    el.style.outline = "2px solid #c00";
    setTimeout(function () { el.style.outline = old; }, 900);
  }

  function keyOf(a) { return ((a.metadata && a.metadata.selector) || "") + "|" + a.text; }

  function ingest(rec) {
    return fetch(BRIDGE + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: location.href, title: document.title, text: rec.text, tag: rec.metadata.tag, metadata: rec.metadata })
    }).then(function (r) {
      if (!r.ok) throw new Error("ingest failed");
      return r.json();
    });
  }

  function postAnnotation(rec) {
    if (!window.fetch) return;
    ingest(rec).then(function (s) {
      bridge = true;
      rec.serverId = s.id;
      render();
    }).catch(function () { bridge = false; render(); });
  }

  function withServerId(rec, then) {
    if (rec.serverId) { then(rec.serverId); return; }
    ingest(rec).then(function (s) {
      rec.serverId = s.id;
      then(s.id);
    }).catch(function () { bridge = false; render(); });
  }

  function setRecStatus(rec, status) {
    rec.status = status;
    render();
    if (!window.fetch) return;
    withServerId(rec, function (id) {
      fetch(BRIDGE + (status === "resolved" ? "/resolve" : "/reopen"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id, by: "user" })
      }).then(function (r) {
        bridge = !!r.ok;
        render();
      }).catch(function () { bridge = false; render(); });
    });
  }

  function deleteRec(rec) {
    if (!window.confirm("Remove this annotation from this tab and the server store?")) return;
    var i = annotations.indexOf(rec);
    if (i >= 0) annotations.splice(i, 1);
    render();
    if (!window.fetch || !rec.serverId) return;
    fetch(BRIDGE + "/annotations/" + rec.serverId, { method: "DELETE" })
      .catch(function () { /* already gone locally */ });
  }

  function sendReply(rec, text) {
    var rp = { by: "user", text: text, at: new Date().toISOString() };
    rec.replies = rec.replies || [];
    rec.replies.push(rp);
    render();
    if (!window.fetch) return;
    withServerId(rec, function (id) {
      fetch(BRIDGE + "/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id, by: "user", text: text })
      }).then(function (r) {
        bridge = !!r.ok;
        render();
      }).catch(function () { bridge = false; render(); });
    });
  }

  function showReplyBox(itemEl, rec) {
    var old = itemEl.querySelector(".ax-replybox");
    if (old) { var inp0 = old.querySelector("input"); if (inp0) inp0.focus(); return; }
    var box = document.createElement("div");
    box.className = "ax-replybox";
    var inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "Reply to agent…";
    inp.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
      if (ev.key === "Enter") sendReplyBox(itemEl, rec);
    });
    inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
    var btn = document.createElement("button");
    btn.className = "ax-mini";
    btn.setAttribute("data-op", "send");
    btn.textContent = "Send";
    box.appendChild(inp);
    box.appendChild(btn);
    itemEl.appendChild(box);
    inp.focus();
  }

  function sendReplyBox(itemEl, rec) {
    var box = itemEl.querySelector(".ax-replybox");
    if (!box) return;
    var text = box.querySelector("input").value.trim();
    box.remove();
    if (!text) return;
    sendReply(rec, text);
  }

  function cropShot(dataUrl, rect, dpr, done) {
    var img = new Image();
    img.onload = function () {
      var scale = dpr || 1;
      var sx = Math.max(0, rect.left) * scale;
      var sy = Math.max(0, rect.top) * scale;
      var sw = Math.min(rect.width * scale, img.naturalWidth - sx);
      var sh = Math.min(rect.height * scale, img.naturalHeight - sy);
      if (sw < 2 || sh < 2) { done(null); return; }
      var k = Math.min(1, 1200 / sw);
      var cv = document.createElement("canvas");
      cv.width = Math.round(sw * k);
      cv.height = Math.round(sh * k);
      cv.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      done(cv.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = function () { done(null); };
    img.src = dataUrl;
  }

  function coveringElements(container) {
    var els = container.querySelectorAll("*");
    var items = [];
    for (var i = 0; i < els.length && items.length < 80; i++) {
      var el = els[i];
      var tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var depth = 0, p = el;
      while (p && p !== container && depth <= 6) { p = p.parentElement; depth++; }
      if (p !== container) continue;
      var text = ((el.innerText || "").trim().replace(/\s+/g, " ")).slice(0, 80);
      if (!text && !el.id && !(el.className && String(el.className).trim())) continue;
      items.push({ selector: selectorFor(el), tag: tag, text: text });
    }
    return { scanned: els.length, items: items };
  }

  function captureElement(el, done) {
    var r = el.getBoundingClientRect();
    var req = {
      type: "ANNOTATE_SHOT",
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      dpr: window.devicePixelRatio || 1
    };
    try {
      chrome.runtime.sendMessage(req, function (res) {
        if (chrome.runtime.lastError || !res || !res.dataUrl) {
          console.warn("[annotate-export] capture failed:", (chrome.runtime.lastError && chrome.runtime.lastError.message) || (res && res.error) || "no data");
          done(null);
          return;
        }
        cropShot(res.dataUrl, req.rect, req.dpr, function (shot) {
          if (!shot) { console.warn("[annotate-export] capture failed: crop failed"); done(null); return; }
          done({ image: shot, coverage: coveringElements(el) });
        });
      });
    } catch (e) {
      console.warn("[annotate-export] capture failed: messaging unavailable");
      done(null);
    }
  }

  function uploadShot(rec, shot) {
    rec.metadata.screenshot = "pending";
    render();
    withServerId(rec, function (id) {
      fetch(BRIDGE + "/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id, image: shot.image, coverage: shot.coverage })
      }).then(function (resp) {
        return resp.json();
      }).then(function (s) {
        rec.metadata.screenshot = (s && s.file) || "saved";
        bridge = true;
        render();
      }).catch(function () {
        console.warn("[annotate-export] screenshot failed: upload failed");
        rec.metadata.screenshot = "failed";
        bridge = false;
        render();
      });
    });
  }

  function saveWithShot(rec, shot) {
    if (!window.fetch) { render(); return; }
    rec.metadata.screenshot = "pending";
    render();
    ingest(rec).then(function (s) {
      rec.serverId = s.id;
      return fetch(BRIDGE + "/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, image: shot.image, coverage: shot.coverage })
      }).then(function (resp) { return resp.json(); });
    }).then(function (s) {
      rec.metadata.screenshot = (s && s.file) || "saved";
      bridge = true;
      render();
    }).catch(function () {
      console.warn("[annotate-export] screenshot failed: save with shot failed");
      rec.metadata.screenshot = "failed";
      bridge = false;
      render();
    });
  }

  function shootRec(rec) {
    function fail(why) {
      console.warn("[annotate-export] screenshot failed:", why);
      rec.metadata.screenshot = "failed";
      render();
    }
    var el = null;
    try { el = document.querySelector(rec.metadata.selector); } catch (err) { el = null; }
    if (!el) { fail("element not found"); return; }
    captureElement(el, function (shot) {
      if (!shot) { fail("capture failed, see console"); return; }
      uploadShot(rec, shot);
    });
  }

  function pullAnnotations() {
    if (!window.fetch) return;
    fetch(BRIDGE + "/annotations?url=" + encodeURIComponent(location.href))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) {
        bridge = true;
        var byKey = {};
        annotations.forEach(function (x) { byKey[keyOf(x)] = x; });
        (items || []).forEach(function (s) {
          var k = ((s.metadata && s.metadata.selector) || "") + "|" + s.text;
          var ex = byKey[k];
          if (ex) {
            if (!ex.serverId) ex.serverId = s.id;
            ex.status = s.status || "open";
            ex.resolvedBy = s.resolvedBy || null;
            ex.replies = s.replies || [];
            return;
          }
          var rec = { id: 0, status: s.status || "open", resolvedBy: s.resolvedBy || null, replies: s.replies || [], text: s.text, serverId: s.id, metadata: s.metadata || {} };
          rec.metadata.tag = s.tag || rec.metadata.tag || "bug";
          seq += 1; rec.id = seq; annotations.push(rec); byKey[k] = rec;
        });
        render();
      }).catch(function () { bridge = false; render(); });
  }

  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || inUI(el)) return;
    hoverEl = pickContainer(el);
  }

  function onClick(e) {
    if (!active) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || inUI(el)) return;
    e.preventDefault();
    e.stopPropagation();
    var target = pickContainer(el);
    if (!shotMode) { pendingShot = null; openForm(target); return; }
    captureElement(target, function (shot) {
      pendingShot = shot;
      openForm(target);
    });
  }

  function onKey(e) {
    var tag = e.target && e.target.tagName;
    var editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (e.target && e.target.isContentEditable);
    if (e.altKey && e.shiftKey && e.code === "KeyA" && !editable) {
      e.preventDefault();
      setActive(!active);
    }
    if (e.key === "Escape" && active) {
      if (pending) closeForm();
      else setActive(false);
    }
  }

  function paint() {
    if (!document.body) { requestAnimationFrame(paint); return; }
    ensureOverlay();
    if (active && hoverEl && document.contains(hoverEl)) {
      var r = hoverEl.getBoundingClientRect();
      dimEl.style.display = "block";
      boxEl.style.display = "block";
      boxEl.style.left = r.left + "px";
      boxEl.style.top = r.top + "px";
      boxEl.style.width = Math.max(r.width, 0) + "px";
      boxEl.style.height = Math.max(r.height, 0) + "px";
    } else {
      dimEl.style.display = "none";
      boxEl.style.display = "none";
    }
    requestAnimationFrame(paint);
  }

  function ensureOverlay() {
    if (dimEl) return;
    dimEl = document.createElement("div");
    dimEl.setAttribute("data-ax-ui", "1");
    dimEl.style.cssText = "position:fixed;inset:0;z-index:2147483644;" +
      "background:rgba(0,0,0,.35);pointer-events:none;display:none;";
    boxEl = document.createElement("div");
    boxEl.setAttribute("data-ax-ui", "1");
    boxEl.style.cssText = "position:fixed;z-index:2147483645;" +
      "background:rgba(66,133,244,.28);border:1px solid rgba(66,133,244,.9);" +
      "pointer-events:none;display:none;";
    document.body.appendChild(dimEl);
    document.body.appendChild(boxEl);
  }

  function setActive(on) {
    active = on;
    if (on) {
      ensureUI();
      root.querySelector(".ax-bar").style.display = "flex";
      root.querySelector(".ax-list").style.display = "block";
      pullAnnotations();
    } else if (root) {
      root.querySelector(".ax-bar").style.display = "none";
      root.querySelector(".ax-list").style.display = "none";
      closeForm();
    }
    render();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", function () { if (annotations.length) drawMarkers(); }, { passive: true });
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "ANNOTATE_TOGGLE") setActive(!active);
    if (msg && msg.type === "ANNOTATE_COPY") copyBrief();
  });
  requestAnimationFrame(paint);
})();
