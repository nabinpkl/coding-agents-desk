/* Toolbar popup: toggle the panel, copy the page brief, sign in or out, and
 * pick the server. Opening the sign-in window closes the popup; the
 * background finishes the flow on its own. */
import type { Annotation } from "../../shared/annotation.ts";
import { buildBrief } from "../../shared/brief.ts";
import { send, type AuthStatus, type TabMessage } from "./messages.ts";

declare const __BUILD__: { version: string; sha: string; at: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>("status");
const authEl = $<HTMLDivElement>("auth");
const errorEl = $<HTMLParagraphElement>("error");
const toggleBtn = $<HTMLButtonElement>("toggle");
const copyBtn = $<HTMLButtonElement>("copy");
const serverForm = $<HTMLFormElement>("server-form");
const serverInput = $<HTMLInputElement>("server-url");

function showError(e: unknown): void {
  errorEl.textContent = e instanceof Error ? e.message : String(e);
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderAuth(s: AuthStatus): void {
  const host = new URL(s.serverUrl).host;
  serverInput.value = s.serverUrl;
  const state = !s.hasPermission ? "no-permission" : s.signedIn ? "signed-in" : "signed-out";
  statusEl.dataset.state = state;
  statusEl.textContent = state === "signed-in" ? "Signed in" : state === "signed-out" ? "Signed out" : "No access";
  const btn = document.createElement("button");
  btn.type = "button";
  const label = document.createElement("span");
  if (!s.hasPermission) {
    label.textContent = `Chrome has not granted access to ${host}`;
    btn.textContent = "Grant";
    btn.addEventListener("click", () => void grantAndSave(s.serverUrl));
  } else if (s.signedIn) {
    label.textContent = host;
    btn.textContent = "Sign out";
    btn.addEventListener("click", () => void run(btn, { type: "sign-out" }));
  } else {
    label.textContent = host;
    btn.textContent = "Sign in";
    btn.className = "primary";
    btn.addEventListener("click", () => void run(btn, { type: "sign-in" }));
  }
  authEl.replaceChildren(label, btn);
  const ready = s.hasPermission && s.signedIn;
  copyBtn.disabled = !ready;
  // One primary action at a time: sign in first, then annotate.
  toggleBtn.className = ready ? "primary" : "";
}

async function run(btn: HTMLButtonElement, req: { type: "sign-in" } | { type: "sign-out" }): Promise<void> {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  errorEl.textContent = "";
  const res = await send<AuthStatus>(req);
  if (res.ok) renderAuth(res.data);
  else {
    showError(res.error);
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

async function grantAndSave(url: string): Promise<void> {
  errorEl.textContent = "";
  const origin = new URL(url).origin;
  // permissions.request needs this popup's user gesture, so it cannot move to the background.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    showError(`Access to ${origin} was not granted.`);
    return;
  }
  const res = await send<AuthStatus>({ type: "set-server-url", url: origin });
  if (res.ok) renderAuth(res.data);
  else showError(res.error);
}

toggleBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab?.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" } satisfies TabMessage);
    window.close();
  } catch {
    showError("This page cannot be annotated (browser pages and the Web Store block extensions). Reload the tab if it was open before the extension loaded.");
  }
});

copyBtn.addEventListener("click", async () => {
  errorEl.textContent = "";
  const tab = await activeTab();
  if (!tab?.url) {
    showError("No page URL for this tab.");
    return;
  }
  copyBtn.disabled = true;
  copyBtn.setAttribute("aria-busy", "true");
  const res = await send<Annotation[]>({ type: "api", method: "GET", path: `/api/v1/annotations?url=${encodeURIComponent(tab.url)}&status=open` });
  copyBtn.removeAttribute("aria-busy");
  copyBtn.disabled = false;
  if (!res.ok) {
    showError(res.error);
    return;
  }
  const items = res.data.sort((a, b) => a.id - b.id);
  await navigator.clipboard.writeText(buildBrief(items, { url: tab.url, title: tab.title ?? "" }));
  copyBtn.textContent = `Copied ${items.length} item${items.length === 1 ? "" : "s"}`;
  setTimeout(() => {
    copyBtn.textContent = "Copy open items as Markdown";
  }, 1500);
});

serverForm.addEventListener("submit", (e) => {
  e.preventDefault();
  try {
    void grantAndSave(new URL(serverInput.value).origin);
  } catch {
    showError("Enter a full URL, e.g. https://annotator.example.com");
  }
});

$<HTMLElement>("build").textContent = `v${__BUILD__.version} · ${__BUILD__.sha} · ${__BUILD__.at}`;

void send<AuthStatus>({ type: "auth-status" }).then((res) => (res.ok ? renderAuth(res.data) : showError(res.error)));
