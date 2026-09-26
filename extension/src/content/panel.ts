/* The in-page panel: toolbar, annotation list, comment form, lightbox, in a
 * Shadow DOM so page styles never leak in or out. Pure view: it renders the
 * state it is given and reports user intent through handlers. Page and user
 * text only ever reaches the DOM through textContent. */
import type { Annotation, Tag } from "../../../shared/annotation.ts";
import type { Recipient, SendInfo, SendState } from "../../../shared/send.ts";
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

/** Where a send has got to, said in the reader's terms rather than the hub's. */
const STATE_TEXT: Record<SendState, string> = {
  queued: "waiting for that session",
  pushed: "handed to that session",
  delivered: "delivered",
  answered: "answered",
  expired: "expired unanswered",
  cancelled: "cancelled",
};

/** The states after which nothing more will happen, so there is no point polling for them. */
export const SETTLED_STATES: ReadonlySet<SendState> = new Set<SendState>(["answered", "expired", "cancelled"]);

/** A home directory has no useful last segment of its own, and the root has none at all. */
function dirLabel(cwd: string | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  // /Users/dev and /home/ubuntu are both "somebody's home", and putting the person's name in a
  // group label helps nobody. The agent-desk picker labels them the same way, on purpose.
  if (parts.length === 2 && (parts[0] === "home" || parts[0] === "Users")) return "home";
  return parts[parts.length - 1]!;
}

export interface RecipientGroup {
  label: string;
  entries: Array<{ address: string; label: string }>;
}

/**
 * The recipient list, as the two sections it actually is.
 *
 * A Bot is not something to send to: the hub resolves `bot:<id>` to whichever member session is
 * live when the message lands, which is a rule the reader cannot see. So a Bot is a group label
 * and its sessions are the choices, and a session that belongs to one appears under it and again
 * under its machine, which is what makes both "the session under this Bot" and "the session in
 * that directory" findable.
 *
 * Two sessions can share a name. When they do, the address becomes the tail, because a reader
 * choosing between "annotator probe" and "annotator probe" has to be able to tell them apart.
 */
export function recipientGroups(recipients: Recipient[]): RecipientGroup[] {
  const botNames = new Map(recipients.filter((r) => r.address.startsWith("bot:")).map((r) => [r.address, r.name]));
  const bots = new Map<string, Recipient[]>();
  const sessions = new Map<string, Recipient[]>();
  for (const entry of recipients) {
    // A Bot is a heading, never a choice: offering `bot:<id>` would send to whichever member
    // session happened to be live, which is a rule the reader cannot see. Its address is not
    // allowed into the sessions section, where it would look exactly like one.
    if (entry.address.startsWith("bot:")) continue;
    // Always under its machine and directory.
    const where = `${entry.machine ?? "unknown machine"} · ${dirLabel(entry.cwd)}`;
    sessions.set(where, [...(sessions.get(where) ?? []), entry]);
    // And, when it belongs to one, under that Bot as well. The same session twice is the point:
    // "the session under this Bot" and "the session in that directory" are both real questions,
    // and answering one of them should not hide the answer to the other.
    const bot = entry.related.find((a) => a.startsWith("bot:"));
    if (bot) bots.set(bot, [...(bots.get(bot) ?? []), entry]);
  }
  const label = (entry: Recipient, group: Recipient[]): string => {
    const base = entry.reachability === "reachable" ? entry.name : `${entry.name} · no live session`;
    return group.filter((other) => other.name === entry.name).length > 1 ? `${base} (${entry.address})` : base;
  };
  const render = (group: Recipient[]): Array<{ address: string; label: string }> => group.map((e) => ({ address: e.address, label: label(e, group) }));
  return [
    ...[...bots].map(([key, group]) => ({ label: `All bots · ${botNames.get(key) ?? key.replace(/^bot:/, "")}`, entries: render(group) })),
    ...[...sessions].map(([key, group]) => ({ label: `All sessions · ${key}`, entries: render(group) })),
  ];
}

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
  /** Everyone the reader can send to, from the hub's directory. */
  recipients: Recipient[];
  /** The remembered address, or "" when there is nothing remembered to offer. */
  to: string;
  sending: boolean;
  sendError: string;
  /** Each annotation's newest send, so the item can say where it got to. */
  sends: ReadonlyMap<number, SendInfo>;
}

export interface PanelHandlers {
  setMode(mode: CaptureMode): void;
  copy(): void;
  download(): void;
  toggleList(): void;
  clear(): void;
  close(): void;
  signIn(): void;
  signOut(): void;
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
  pickRecipient(address: string): void;
  sendToAgent(): void;
}

declare const __BUILD__: { version: string; sha: string; at: string };

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

  // ----- Send -----

  const sendCount = h("span", { class: "send-count" });
  const toSelect = h("select", { class: "send-to", "aria-label": "Send to" });
  const sendBtn = iconButton("send", "Send these annotations to that session", on.sendToAgent);
  const sendError = h("div", { class: "send-error", role: "alert" });
  const sendBar = h("div", { class: "sendbar" }, h("div", { class: "send-row" }, sendCount, toSelect, sendBtn), sendError);
  toSelect.addEventListener("click", (e) => e.stopPropagation());
  toSelect.addEventListener("change", () => on.pickRecipient(toSelect.value));

  const dock = h("div", { class: "dock" }, bar, sendBar, list);
  root.append(dock, form, light);

  function renderSendBar(s: PanelState): void {
    const open = s.items.filter((a) => a.status === "open");
    // Nothing to send, or nowhere to send it: the row is taken away rather than shown disabled,
    // because a control that cannot be used is a question the panel cannot answer.
    const show = s.status === "connected" && open.length > 0;
    sendBar.hidden = !show;
    if (!show) return;
    const who = s.recipients.find((r) => r.address === s.to);
    sendCount.textContent = `Send ${open.length} to`;
    toSelect.replaceChildren(
      // A remembered address the directory no longer has is named rather than silently dropped, so
      // the reader is not left wondering why their usual session is not in the list.
      ...(who ? [] : [h("option", { value: "" }, s.to ? `${s.to} (no longer listed)` : "Pick a session")]),
      ...recipientGroups(s.recipients).map((g) => h("optgroup", { label: g.label }, ...g.entries.map((e) => h("option", { value: e.address, title: e.label }, e.label)))),
    );
    toSelect.value = s.to;
    sendBtn.disabled = !s.to || s.sending;
    sendBtn.setAttribute("aria-busy", s.sending ? "true" : "false");
    sendBtn.setAttribute("aria-label", who ? `Send ${open.length} annotations to ${who.name}` : "Send these annotations to that session");
    sendError.textContent = s.sendError;
  }

  function renderBar(s: PanelState): void {
    const dotTitle =
      s.status === "connected" ? `Connected to ${s.serverLabel}` : s.status === "offline" ? `Offline: ${s.statusDetail}` : s.status === "signed-out" ? `Signed out of ${s.serverLabel}` : "Connecting";
    const openCount = s.items.filter((a) => a.status === "open").length;
    bar.replaceChildren(
      h("span", { class: "title", title: `v${__BUILD__.version} · ${__BUILD__.sha} · ${__BUILD__.at}` }, "Annotate"),
      h("span", { class: "count", title: `${openCount} open` }, String(openCount)),
      h("span", { class: "dot", "data-status": s.status, title: dotTitle, role: "status", "aria-label": dotTitle }),
      h("span", { class: "modes", role: "group", "aria-label": "Capture mode" },
        ...MODES.map((m) => textButton(m.label, () => on.setMode(m.mode), { "aria-pressed": s.mode === m.mode ? "true" : "false", title: m.title }))),
      h("span", { class: "sep" }),
      iconButton("copy", "Copy Markdown brief", on.copy, { disabled: s.items.length === 0 }),
      iconButton("download", "Download brief (.md)", on.download, { disabled: s.items.length === 0 }),
      iconButton(s.listOpen ? "chevronUp" : "chevronDown", s.listOpen ? "Hide list" : "Show list", on.toggleList),
      iconButton("trash", "Clear this page's annotations", on.clear, { danger: true, disabled: s.items.length === 0 || s.status !== "connected" }),
      ...(s.status === "connected" ? [iconButton("logOut", `Sign out of ${s.serverLabel}`, on.signOut)] : []),
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
    const sent = s.sends.get(a.id);
    if (sent) {
      item.append(
        h(
          "div",
          { class: "sent", "data-state": sent.state, title: `Hub message ${sent.messageId}` },
          h("span", { class: "sent-to" }, sent.toName),
          h("span", { class: "sent-state" }, `· ${STATE_TEXT[sent.state] ?? sent.state}`),
        ),
      );
    }
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
      renderSendBar(s);
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
