import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentUiRequest } from "./agentBackend.ts";

type UiListener = (request: AgentUiRequest) => void;

interface PendingRequest {
  request: AgentUiRequest;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAXIMUM_UI_TEXT_BYTES = 64 * 1024;
const MAXIMUM_UI_LIST_ITEMS = 128;
const textEncoder = new TextEncoder();

export class AgentUiBroker {
  private readonly listeners = new Set<UiListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  subscribe(listener: UiListener): () => void {
    this.listeners.add(listener);
    for (const pending of this.pending.values()) listener(pending.request);
    return () => this.listeners.delete(listener);
  }

  notify(request: Omit<AgentUiRequest, "requestId" | "expectsResponse">): void {
    this.publish(boundUiRequest({ ...request, requestId: this.nextId(), expectsResponse: false }));
  }

  request(request: Omit<AgentUiRequest, "requestId" | "expectsResponse">): Promise<unknown> {
    const value = boundUiRequest({ ...request, requestId: this.nextId(), expectsResponse: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(value.requestId);
        resolve(undefined);
      }, this.timeoutMs);
      this.pending.set(value.requestId, { request: value, resolve, timer });
      this.publish(value);
    });
  }

  respond(requestId: string, value: unknown): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private nextId(): string {
    return `ui-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
  }

  private publish(request: AgentUiRequest): void {
    for (const listener of this.listeners) listener(request);
  }
}

export function extensionUiContext(broker: AgentUiBroker): ExtensionUIContext {
  let editorText = "";
  return {
    async select(title, options) {
      const visibleOptions = boundTextList(options, 48 * 1024);
      const value = await broker.request({ kind: "select", title, options: visibleOptions });
      return typeof value === "string" && visibleOptions.includes(value) ? value : undefined;
    },
    async confirm(title, message) {
      return await broker.request({ kind: "confirm", title, message }) === true;
    },
    async input(title, placeholder) {
      const value = await broker.request({ kind: "input", title, placeholder });
      return typeof value === "string" ? value : undefined;
    },
    notify(message, level = "info") {
      broker.notify({ kind: "notify", message, level });
    },
    onTerminalInput() { return () => {}; },
    setStatus(key, text) {
      broker.notify({ kind: "status", key, message: text });
    },
    setWorkingMessage(message) {
      broker.notify({ kind: "status", key: "working", message });
    },
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key, content) {
      if (content === undefined || Array.isArray(content)) {
        broker.notify({ kind: "widget", key, lines: content });
      } else {
        broker.notify({ kind: "notify", level: "warning", message: `Extension widget "${key}" requires terminal UI` });
      }
    },
    setFooter() {},
    setHeader() {},
    setTitle(title) { broker.notify({ kind: "status", key: "title", message: title }); },
    async custom() {
      broker.notify({ kind: "notify", level: "warning", message: "This extension requires unsupported terminal UI" });
      throw new Error("custom extension terminal UI is unsupported in AgentDesk");
    },
    pasteToEditor(text) { editorText = appendBoundedText(editorText, text, MAXIMUM_UI_TEXT_BYTES); },
    setEditorText(text) { editorText = boundText(text, MAXIMUM_UI_TEXT_BYTES); },
    getEditorText() { return editorText; },
    async editor(title, prefill) {
      const value = await broker.request({ kind: "editor", title, prefill });
      return typeof value === "string" ? value : undefined;
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false, error: "theme changes are unsupported in AgentDesk" }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
  };
}

function boundUiRequest(request: AgentUiRequest): AgentUiRequest {
  let remainingBytes = MAXIMUM_UI_TEXT_BYTES;
  const take = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundText(value, remainingBytes);
    remainingBytes -= textEncoder.encode(bounded).byteLength;
    return bounded;
  };
  const takeList = (values: string[] | undefined): string[] | undefined => {
    if (values === undefined) return undefined;
    const result: string[] = [];
    for (const value of values.slice(0, MAXIMUM_UI_LIST_ITEMS)) {
      if (remainingBytes === 0) break;
      const bounded = take(value);
      if (bounded !== undefined) result.push(bounded);
    }
    return result;
  };
  return {
    ...request,
    title: take(request.title),
    message: take(request.message),
    options: takeList(request.options),
    placeholder: take(request.placeholder),
    prefill: take(request.prefill),
    key: take(request.key),
    lines: takeList(request.lines),
  };
}

function boundTextList(values: string[], maximumBytes: number): string[] {
  let remainingBytes = maximumBytes;
  const result: string[] = [];
  for (const value of values.slice(0, MAXIMUM_UI_LIST_ITEMS)) {
    if (remainingBytes === 0) break;
    const bounded = boundText(value, remainingBytes);
    remainingBytes -= textEncoder.encode(bounded).byteLength;
    result.push(bounded);
  }
  return result;
}

function appendBoundedText(current: string, addition: string, maximumBytes: number): string {
  const boundedCurrent = boundText(current, maximumBytes);
  const remainingBytes = maximumBytes - textEncoder.encode(boundedCurrent).byteLength;
  return boundedCurrent + boundText(addition, remainingBytes);
}

function boundText(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (value.length <= maximumBytes && textEncoder.encode(value).byteLength <= maximumBytes) return value;
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const bytes = textEncoder.encode(character).byteLength;
    if (usedBytes + bytes > maximumBytes) break;
    result += character;
    usedBytes += bytes;
  }
  return result;
}
