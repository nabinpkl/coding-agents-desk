import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type AgentUiRequestKind = "select" | "confirm" | "input" | "editor" | "notify" | "status" | "widget";

export interface AgentUiRequest {
  requestId: string;
  kind: AgentUiRequestKind;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  level?: "info" | "warning" | "error";
  key?: string;
  lines?: string[];
  expectsResponse: boolean;
}

type UiListener = (request: AgentUiRequest) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentUiBroker {
  private readonly listeners = new Set<UiListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  subscribe(listener: UiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(request: Omit<AgentUiRequest, "requestId" | "expectsResponse">): void {
    this.publish({ ...request, requestId: this.nextId(), expectsResponse: false });
  }

  request(request: Omit<AgentUiRequest, "requestId" | "expectsResponse">): Promise<unknown> {
    const value: AgentUiRequest = { ...request, requestId: this.nextId(), expectsResponse: true };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(value.requestId);
        resolve(undefined);
      }, this.timeoutMs);
      this.pending.set(value.requestId, { resolve, timer });
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
      const value = await broker.request({ kind: "select", title, options });
      return typeof value === "string" && options.includes(value) ? value : undefined;
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
    pasteToEditor(text) { editorText += text; },
    setEditorText(text) { editorText = text; },
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
