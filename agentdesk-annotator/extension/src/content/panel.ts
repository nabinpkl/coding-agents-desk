/* The in-page panel: toolbar, annotation list, comment form, lightbox, in a
 * Shadow DOM so page styles never leak in or out. Pure view: it renders the
 * state it is given and reports user intent through handlers. Page and user
 * text only ever reaches the DOM through textContent. */
import type { Annotation, StyleChange, Tag } from "../../../shared/annotation.ts";
import type { Recipient, SendInfo, SendState } from "../../../shared/send.ts";
import { DEFAULT_TAG, STYLE_PROPERTY_LABELS, TAG_MEANINGS, TAGS } from "../../../shared/vocab.ts";
import { makeDraggable, placeBeside } from "./formPlacement.ts";
import { h, iconButton, textButton } from "./dom.ts";
import { icon } from "./icons.ts";
import { createPreviewBanner, type PreviewBannerHandlers, type PreviewView } from "./previewBanner.ts";
import { PANEL_CSS } from "./styles.ts";
import { mount } from "./topLayer.ts";

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
 * The recipient list, as the sections it actually is: one per Bot, holding the sessions it curates.
 *
 * A Bot is the address, and a session is reachable only through the Bot curating it, so the grouping
 * is the whole of the address space rather than a convenience. The hub does not list a session in no
 * Bot, so there is nothing else to offer: a session the owner has not put in a Bot is not something
 * this could deliver to, and a row for it would fail on use. Each row carries the address that reaches
 * that session, which the hub supplies, so nothing here assembles one.
 *
 * Two sessions can share a name. When they do, the session tail becomes the label, because a reader
 * choosing between "annotator probe" and "annotator probe" has to be able to tell them apart.
 */
export function recipientGroups(recipients: Recipient[]): RecipientGroup[] {
  const botNames = new Map(recipients.filter((r) => r.session === null && r.address.startsWith("bot:")).map((r) => [r.address, r.name]));
  const bots = new Map<string, Recipient[]>();
  for (const entry of recipients) {
    if (entry.session === null) continue;
    const bot = entry.related.find((a) => a.startsWith("bot:"));
    if (!bot) continue;
    bots.set(bot, [...(bots.get(bot) ?? []), entry]);
  }
  const label = (entry: Recipient, group: Recipient[]): string => {
    const base = entry.reachability === "reachable" ? entry.name : `${entry.name} · no live session`;
    return group.filter((other) => other.name === entry.name).length > 1 ? `${base} (${entry.session})` : base;
  };
  const render = (group: Recipient[]): Array<{ address: string; label: string }> => group.map((e) => ({ address: e.address, label: label(e, group) }));
  return [...bots].map(([key, group]) => ({ label: `All bots · ${botNames.get(key) ?? key.replace(/^bot:/, "")}`, entries: render(group) }));
}

/**
 * The open annotations no send has reached a session with yet: never sent, or sent and expired or
 * cancelled. These are what the send bar offers, so one already handed over from the comment form is
 * not sent a second time with the rest.
 */
export function awaitingSend(items: Annotation[], sends: ReadonlyMap<number, SendInfo>): Annotation[] {
  return items.filter((a) => {
    const sent = sends.get(a.id);
    return a.status === "open" && (!sent || sent.state === "expired" || sent.state === "cancelled");
  });
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
  /** The page's preview while it is on, or null when it is off. */
  preview: PreviewView | null;
}

/**
 * What the form is open for. `comment` annotates one thing; `edit` changes an element's style in the
 * preview, with no comment; `batch` saves every previewed change, one annotation each.
 */
export type FormSpec =
  | { variant: "comment"; region: boolean; detail: string; fontSize: number | null; target: DOMRect }
  | { variant: "edit"; detail: string; fontSize: number; target: DOMRect }
  | { variant: "batch"; detail: string; count: number };

export interface PanelHandlers extends PreviewBannerHandlers {
  togglePreview(): void;
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
  /** The form's primary action. `to` is the address to send to once saved, or "" to keep it for a later send. */
  save(text: string, tag: Tag, to: string): void;
  cancelForm(): void;
  /** Show the picked element at this font size, or put its own size back when null. */
  setFontSize(px: number | null): void;
  pickRecipient(address: string): void;
  sendToAgent(): void;
}

declare const __BUILD__: { version: string; sha: string; at: string };

export const HOST_ID = "__agentdesk_annotator_host";

export interface Panel {
  host: HTMLElement;
  render(state: PanelState): void;
  show(visible: boolean): void;
  /** Opens the form beside its target where it has one, and in the middle of the page where it does not. */
  openForm(spec: FormSpec): void;
  /** The size now shown on the page, and what that changes, or null when it is back where it started. */
  showFontSize(px: number, change: StyleChange | null): void;
  setFormBusy(busy: boolean): void;
  /** How many a batch save has left to write, after some of it was saved. */
  setBatchCount(count: number): void;
  setFormError(message: string): void;
  closeForm(): void;
  formOpen(): boolean;
  lightbox(src: string): void;
}

export function createPanel(on: PanelHandlers): Panel {
  const host = h("div", { id: HOST_ID, "data-ax-ui": "1" });
  mount(host);
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

  // ----- font size -----

  // The comment a size change suggests, kept only while the reader has not written their own.
  let fontSize = 0;
  let suggestedText = "";

  const sizeInput = h("input", { id: "ax-font-size", class: "size-input", type: "number", step: "1", inputmode: "decimal" });
  const sizeButton = (name: "minus" | "plus", label: string, sign: number): HTMLButtonElement => {
    const b = h("button", { class: "icon-btn", type: "button", "aria-label": label, title: `${label} (Shift: 4px)` }, icon(name));
    b.addEventListener("click", (e) => on.setFontSize(fontSize + sign * (e.shiftKey ? 4 : 1)));
    return b;
  };
  const smaller = sizeButton("minus", "Smaller", -1);
  const larger = sizeButton("plus", "Larger", 1);
  const resetSize = textButton("Reset", () => on.setFontSize(null));
  const sizeRow = h(
    "div",
    { class: "size-row" },
    h("label", { class: "size-label", for: "ax-font-size" }, "Font size"),
    h("span", { class: "stepper", role: "group", "aria-label": "Font size" }, smaller, sizeInput, h("span", { class: "unit" }, "px"), larger),
    resetSize,
  );
  sizeInput.addEventListener("input", () => {
    const px = sizeInput.valueAsNumber;
    if (Number.isFinite(px) && px > 0) on.setFontSize(px);
  });
  sizeInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      on.setFontSize(fontSize + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 4 : 1));
    }
    if (e.key === "Escape") on.cancelForm();
  });
  // A half-typed or out-of-range number gives way to the size actually on the page.
  sizeInput.addEventListener("blur", () => {
    sizeInput.value = String(fontSize);
  });

  // ----- send to -----

  // Who this one annotation goes to once saved. None by default, every time: an annotation kept back
  // is collected, and the send bar hands over everything collected later.
  const formTo = h("select", { class: "form-to", "aria-label": "Send to" });
  let formToKey = "";
  let spec: FormSpec | null = null;
  const saveLabel = () => {
    if (spec?.variant === "edit") return "Done";
    const what = spec?.variant === "batch" ? `Save ${spec.count}` : "Save";
    return formTo.value ? `${what} and send` : what;
  };
  formTo.addEventListener("change", () => {
    saveBtn.textContent = saveLabel();
  });
  const submit = () => on.save(textarea.value.trim(), tagSelect.value as Tag, formTo.value);

  const tagRow = h("div", { class: "form-row" }, tagSelect, formTo);
  const formHead = h("div", { class: "form-head", title: "Drag to move" }, formTitle, iconButton("x", "Cancel", () => on.cancelForm()));
  const form = h(
    "div",
    { class: "form", role: "dialog", "aria-label": "Annotate container", hidden: true },
    formHead,
    selectorLine,
    textarea,
    sizeRow,
    tagRow,
    h("div", { class: "form-row form-actions" }, cancelBtn, saveBtn),
    formError,
  );
  makeDraggable(form, formHead);
  saveBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => on.cancelForm());
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
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
  const preview = createPreviewBanner(on);
  root.append(preview.frame, preview.banner, dock, form, light);
  // The toolbar sits below the banner rather than on top of it, following the banner's height as it
  // changes: a wrapped row, an error line, the review list opening.
  new ResizeObserver(() => {
    dock.style.top = preview.banner.hidden ? "" : `${preview.banner.getBoundingClientRect().bottom + 8}px`;
  }).observe(preview.banner);

  /** The form's recipient list, rebuilt only when the directory changes so a poll never closes an open dropdown. */
  function renderFormRecipients(s: PanelState): void {
    const groups = s.status === "connected" ? recipientGroups(s.recipients) : [];
    const key = JSON.stringify(groups);
    if (key === formToKey) return;
    formToKey = key;
    const chosen = formTo.value;
    formTo.replaceChildren(
      h("option", { value: "" }, "Send to: none, keep for later"),
      ...groups.map((g) => h("optgroup", { label: g.label }, ...g.entries.map((e) => h("option", { value: e.address, title: e.label }, e.label)))),
    );
    formTo.value = groups.some((g) => g.entries.some((e) => e.address === chosen)) ? chosen : "";
    formTo.hidden = groups.length === 0;
    saveBtn.textContent = saveLabel();
  }

  function renderSendBar(s: PanelState): void {
    const open = awaitingSend(s.items, s.sends);
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
      textButton("Preview", on.togglePreview, { "aria-pressed": s.preview ? "true" : "false", title: s.preview ? "Leave preview (your changes are kept)" : "Try out changes on the page before saving them" }),
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
      ...(a.metadata.styleChanges ?? []).map((c) => h("div", { class: "change" }, `${c.property} ${c.from} → ${c.to}`)),
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
      renderFormRecipients(s);
      preview.render(s.preview);
    },
    show(visible) {
      dock.hidden = !visible;
    },
    openForm(next) {
      spec = next;
      const edit = next.variant === "edit";
      formTitle.textContent =
        next.variant === "batch" ? `Save ${next.count} previewed change${next.count === 1 ? "" : "s"}` : edit ? "Preview a change" : next.region ? "Annotate region" : "Annotate container";
      form.setAttribute("aria-label", formTitle.textContent);
      textarea.placeholder =
        next.variant === "batch" ? "A note added to each of them (optional)" : next.variant === "comment" && next.region ? "What is wrong in this area?" : "What is wrong with this container?";
      selectorLine.textContent = next.detail;
      formError.textContent = "";
      textarea.value = "";
      textarea.hidden = edit;
      tagRow.hidden = cancelBtn.hidden = edit;
      tagSelect.value = DEFAULT_TAG;
      formTo.value = "";
      suggestedText = "";
      const size = next.variant === "batch" ? null : next.fontSize;
      sizeRow.hidden = size === null;
      fontSize = size ?? 0;
      sizeInput.value = String(fontSize);
      resetSize.disabled = true;
      form.hidden = false;
      if (next.variant === "batch") {
        form.style.left = form.style.top = form.style.transform = "";
      } else {
        placeBeside(form, next.target);
      }
      saveBtn.disabled = false;
      saveBtn.textContent = saveLabel();
      queueMicrotask(() => (edit ? sizeInput : textarea).focus());
    },
    showFontSize(px, change) {
      fontSize = px;
      // Not while the reader is typing in it: rewriting the field would fight their keystrokes.
      if (shadow.activeElement !== sizeInput) sizeInput.value = String(px);
      resetSize.disabled = change === null;
      const text = change ? `${STYLE_PROPERTY_LABELS[change.property]} ${change.from} → ${change.to}` : "";
      if (textarea.value === suggestedText) {
        textarea.value = text;
        suggestedText = text;
      }
    },
    setFormBusy(busy) {
      saveBtn.disabled = busy;
      for (const control of [smaller, larger, sizeInput, resetSize, formTo]) control.disabled = busy;
      saveBtn.setAttribute("aria-busy", busy ? "true" : "false");
      saveBtn.textContent = busy ? "Saving" : saveLabel();
      textarea.readOnly = busy;
    },
    setBatchCount(count) {
      if (spec?.variant !== "batch") return;
      spec = { ...spec, count };
      formTitle.textContent = `Save ${count} previewed change${count === 1 ? "" : "s"}`;
      saveBtn.textContent = saveLabel();
    },
    setFormError(message) {
      formError.textContent = message;
    },
    closeForm() {
      form.hidden = true;
      spec = null;
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
