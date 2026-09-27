/* The in-page panel: toolbar, annotation list, comment form, lightbox, in a
 * Shadow DOM so page styles never leak in or out. Pure view: it renders the
 * state it is given and reports user intent through handlers. Page and user
 * text only ever reaches the DOM through textContent. */
import type { Annotation, Tag } from "../../../shared/annotation.ts";
import { DEFAULT_TAG, TAG_MEANINGS, TAGS } from "../../../shared/vocab.ts";
import { icon, type IconName } from "./icons.ts";
import { PANEL_CSS } from "./styles.ts";

export type ConnStatus = "unknown" | "connected" | "offline" | "signed-out";

/** Element records the clicked container, Shot also screenshots it, Region screenshots a dragged rectangle. */
export type CaptureMode = "element" | "shot" | "region";

const MODES: ReadonlyArray<{ mode: CaptureMode; label: string; title: string }> = [
  { mode: "element", label: "Element", title: "Click a container to annotate it" },
  { mode: "shot", label: "Shot", title: "Click a container to annotate and screenshot it" },
  { mode: "region", label: "Region", title: "Drag a rectangle to annotate and screenshot it" },
];

export interface PanelState {
  status: ConnStatus;
  statusDetail: string;
  serverLabel: string;
  items: Annotation[];
  mode: CaptureMode;
  listOpen: boolean;
  signingIn: boolean;
  busy: ReadonlySet<number>;
  errors: ReadonlyMap<number, string>;
  thumbs: ReadonlyMap<number, string>;
  replyOpen: number | null;
  replyDrafts: ReadonlyMap<number, string>;
}

export interface PanelHandlers {
  setMode(mode: CaptureMode): void;
  copy(): void;
  download(): void;
  toggleList(): void;
  clear(): void;
  close(): void;
  signIn(): void;
  retry(): void;
  locate(a: Annotation): void;
  resolve(a: Annotation): void;
  reopen(a: Annotation): void;
  remove(a: Annotation): void;
  openReply(a: Annotation): void;
  draftReply(a: Annotation, text: string): void;
  sendReply(a: Annotation): void;
  shoot(a: Annotation): void;
  save(text: string, tag: Tag): void;
  cancelForm(): void;
}

export const HOST_ID = "__agentdesk_annotator_host";

type Attrs = Record<string, string | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) el.append(c);
  return el;
}

function iconButton(name: IconName, label: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean; busy?: boolean } = {}): HTMLButtonElement {
  const b = h("button", {
    class: `icon-btn${opts.danger ? " danger" : ""}`,
    type: "button",
    "aria-label": label,
    title: label,
    disabled: opts.disabled || opts.busy,
    "aria-busy": opts.busy ? "true" : undefined,
  }, icon(name));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function textButton(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h("button", { class: "text-btn", type: "button", ...attrs }, label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export interface Panel {
  host: HTMLElement;
  render(state: PanelState): void;
  show(visible: boolean): void;
  openForm(kind: "container" | "region", detail: string): void;
  setFormBusy(busy: boolean): void;
  setFormError(message: string): void;
  closeForm(): void;
  formOpen(): boolean;
  lightbox(src: string): void;
}

export function createPanel(on: PanelHandlers): Panel {
  const host = h("div", { id: HOST_ID, "data-ax-ui": "1" });
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  const root = h("div", { class: "root" });
  shadow.append(style, root);

  const bar = h("div", { class: "bar", role: "toolbar", "aria-label": "Annotator" });
  const list = h("div", { class: "list", role: "list" });

  const textarea = h("textarea", { rows: "4", placeholder: "What is wrong with this container?", "aria-label": "Comment" });
  const tagSelect = h("select", { "aria-label": "Tag" }, ...TAGS.map((t) => h("option", { value: t, title: `Agent will: ${TAG_MEANINGS[t]}` }, t)));
  const selectorLine = h("div", { class: "selector" });
  const formError = h("div", { class: "form-error", role: "alert" });
  const formTitle = h("span", {}, "Annotate container");
  const saveBtn = h("button", { class: "primary", type: "button" }, "Save");
  const cancelBtn = h("button", { class: "ghost", type: "button" }, "Cancel");
  const form = h(
    "div",
    { class: "form", role: "dialog", "aria-label": "Annotate container", hidden: true },
    h("div", { class: "form-head" }, formTitle, iconButton("x", "Cancel", () => on.cancelForm())),
    selectorLine,
    textarea,
    h("div", { class: "form-row" }, tagSelect, h("span", { class: "spacer" }), cancelBtn, saveBtn),
    formError,
  );
  saveBtn.addEventListener("click", () => on.save(textarea.value.trim(), tagSelect.value as Tag));
  cancelBtn.addEventListener("click", () => on.cancelForm());
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) on.save(textarea.value.trim(), tagSelect.value as Tag);
    if (e.key === "Escape") on.cancelForm();
  });

  const lightImg = h("img", { alt: "Element screenshot" });
  const light = h("div", { class: "light", hidden: true }, lightImg);
  light.addEventListener("click", () => {
    light.hidden = true;
  });

  const dock = h("div", { class: "dock" }, bar, list);
  root.append(dock, form, light);

  function renderBar(s: PanelState): void {
    const dotTitle =
      s.status === "connected" ? `Connected to ${s.serverLabel}` : s.status === "offline" ? `Offline: ${s.statusDetail}` : s.status === "signed-out" ? `Signed out of ${s.serverLabel}` : "Connecting";
    const openCount = s.items.filter((a) => a.status === "open").length;
    bar.replaceChildren(
      h("span", { class: "title" }, "Annotate"),
      h("span", { class: "count", title: `${openCount} open` }, String(openCount)),
      h("span", { class: "dot", "data-status": s.status, title: dotTitle, role: "status", "aria-label": dotTitle }),
      h("span", { class: "modes", role: "group", "aria-label": "Capture mode" },
        ...MODES.map((m) => textButton(m.label, () => on.setMode(m.mode), { "aria-pressed": s.mode === m.mode ? "true" : "false", title: m.title }))),
      h("span", { class: "sep" }),
      iconButton("copy", "Copy Markdown brief", on.copy, { disabled: s.items.length === 0 }),
      iconButton("download", "Download brief (.md)", on.download, { disabled: s.items.length === 0 }),
      iconButton(s.listOpen ? "chevronUp" : "chevronDown", s.listOpen ? "Hide list" : "Show list", on.toggleList),
      iconButton("trash", "Clear this page's annotations", on.clear, { danger: true, disabled: s.items.length === 0 || s.status !== "connected" }),
      iconButton("x", "Turn off annotate mode", on.close),
    );
  }

  function renderItem(a: Annotation, i: number, s: PanelState): HTMLElement {
    const busy = s.busy.has(a.id);
    const connected = s.status === "connected";
    const resolved = a.status === "resolved";
    const label = h(
      "div",
      { class: "label" },
      h("span", {}, `${i + 1}. `),
      h("span", { class: "text" }, a.text),
      resolved ? h("div", { class: "meta" }, `resolved by ${a.resolvedBy ?? "?"}`) : "",
    );
    const actions = [
      resolved
        ? iconButton("undo", "Reopen", () => on.reopen(a), { disabled: !connected, busy })
        : iconButton("check", "Mark resolved", () => on.resolve(a), { disabled: !connected, busy }),
      iconButton("reply", "Reply to agent", () => on.openReply(a), { disabled: !connected }),
      iconButton("camera", a.screenshot ? "Retake screenshot" : "Screenshot element", () => on.shoot(a), { disabled: !connected, busy }),
      iconButton("trash", "Delete annotation", () => on.remove(a), { danger: true, disabled: !connected, busy }),
    ];
    const item = h("div", { class: `item${resolved ? " resolved" : ""}`, role: "listitem", "data-tag": a.tag, title: `[${a.tag}] click to locate` }, h("div", { class: "row" }, label, ...actions));
    item.addEventListener("click", () => on.locate(a));
    for (const r of a.replies) item.append(h("div", { class: "reply" }, h("span", { class: "by" }, `${r.by}: `), r.text));
    const thumb = s.thumbs.get(a.id);
    if (thumb) {
      const img = h("img", { class: "thumb", src: thumb, alt: "Element screenshot", title: "Enlarge" });
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        lightImg.src = thumb;
        light.hidden = false;
      });
      item.append(img);
    }
    if (s.replyOpen === a.id) {
      const input = h("input", { type: "text", placeholder: "Reply to agent", "aria-label": "Reply to agent" });
      input.value = s.replyDrafts.get(a.id) ?? "";
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("input", () => on.draftReply(a, input.value));
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") on.sendReply(a);
      });
      item.append(h("div", { class: "replybox" }, input, iconButton("send", "Send reply", () => on.sendReply(a), { busy, disabled: !connected })));
      queueMicrotask(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
    const err = s.errors.get(a.id);
    if (err) item.append(h("div", { class: "item-error", role: "alert" }, err));
    return item;
  }

  function renderList(s: PanelState): void {
    list.hidden = !s.listOpen;
    const rows: HTMLElement[] = [];
    if (s.status === "signed-out") {
      rows.push(h("div", { class: "banner" }, h("span", {}, `Signed out of ${s.serverLabel}`), textButton(s.signingIn ? "Signing in" : "Sign in", on.signIn, { disabled: s.signingIn, "aria-busy": s.signingIn ? "true" : undefined })));
    } else if (s.status === "offline") {
      rows.push(h("div", { class: "banner" }, h("span", {}, `Server unreachable: ${s.statusDetail}`), textButton("Retry", on.retry)));
    }
    if (s.items.length === 0 && s.status === "connected") rows.push(h("div", { class: "empty" }, s.mode === "region" ? "No annotations on this page yet. Drag over an area." : "No annotations on this page yet. Click a container."));
    s.items.forEach((a, i) => rows.push(renderItem(a, i, s)));
    list.replaceChildren(...rows);
  }

  return {
    host,
    render(s) {
      renderBar(s);
      renderList(s);
    },
    show(visible) {
      dock.hidden = !visible;
    },
    openForm(kind, detail) {
      formTitle.textContent = kind === "region" ? "Annotate region" : "Annotate container";
      textarea.placeholder = kind === "region" ? "What is wrong in this area?" : "What is wrong with this container?";
      selectorLine.textContent = detail;
      formError.textContent = "";
      textarea.value = "";
      tagSelect.value = DEFAULT_TAG;
      form.hidden = false;
      saveBtn.disabled = false;
      queueMicrotask(() => textarea.focus());
    },
    setFormBusy(busy) {
      saveBtn.disabled = busy;
      saveBtn.setAttribute("aria-busy", busy ? "true" : "false");
      saveBtn.textContent = busy ? "Saving" : "Save";
      textarea.readOnly = busy;
    },
    setFormError(message) {
      formError.textContent = message;
    },
    closeForm() {
      form.hidden = true;
    },
    formOpen() {
      return !form.hidden;
    },
    lightbox(src) {
      lightImg.src = src;
      light.hidden = false;
    },
  };
}
