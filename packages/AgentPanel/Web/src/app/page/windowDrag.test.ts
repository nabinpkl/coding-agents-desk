import { afterEach, describe, expect, it, vi } from "vitest";
import { installWindowDrag, isWindowDragTarget } from "@/app/page/windowDrag";

function buildTitlebar(): {
  header: HTMLElement;
  title: HTMLElement;
  control: HTMLButtonElement;
  meter: HTMLElement;
  body: HTMLElement;
} {
  document.body.innerHTML = `
    <header data-window-drag>
      <button type="button" id="control"><span id="icon"></span></button>
      <h1 id="title">Agent Feed</h1>
      <span id="meter" data-window-no-drag><span id="meter-fill"></span></span>
    </header>
    <main id="body"><p id="paragraph">transcript</p></main>
  `;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    header: document.querySelector("header") as HTMLElement,
    title: byId("title"),
    control: byId("control") as HTMLButtonElement,
    meter: byId("meter"),
    body: byId("body"),
  };
}

function mouseDown(target: Element, button = 0): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  delete window.__agentDeskBeginWindowDrag;
  document.body.innerHTML = "";
});

describe("window drag hit testing", () => {
  it("treats the title bar background and its title as draggable", () => {
    const { header, title } = buildTitlebar();

    expect(isWindowDragTarget(header)).toBe(true);
    expect(isWindowDragTarget(title)).toBe(true);
  });

  it("leaves controls and their icons to the control", () => {
    const { control } = buildTitlebar();

    expect(isWindowDragTarget(control)).toBe(false);
    // The icon, not the button, is the real click target for an icon-only control.
    expect(isWindowDragTarget(document.getElementById("icon"))).toBe(false);
  });

  it("honours an explicit no-drag opt-out and its descendants", () => {
    const { meter } = buildTitlebar();

    expect(isWindowDragTarget(meter)).toBe(false);
    expect(isWindowDragTarget(document.getElementById("meter-fill"))).toBe(false);
  });

  it("ignores everything outside a drag region", () => {
    const { body } = buildTitlebar();

    expect(isWindowDragTarget(body)).toBe(false);
    expect(isWindowDragTarget(document.getElementById("paragraph"))).toBe(false);
    expect(isWindowDragTarget(null)).toBe(false);
  });

  it("does not let an interactive ancestor of the region veto a background drag", () => {
    document.body.innerHTML = `
      <div role="button"><header data-window-drag><h1 id="t">Agent Feed</h1></header></div>
    `;

    expect(isWindowDragTarget(document.getElementById("t"))).toBe(true);
  });
});

describe("window drag installation", () => {
  it("starts a native drag for an inert title-bar press", () => {
    const beginWindowDrag = vi.fn();
    window.__agentDeskBeginWindowDrag = beginWindowDrag;
    const { title } = buildTitlebar();
    const drag = installWindowDrag();

    const event = mouseDown(title);

    expect(beginWindowDrag).toHaveBeenCalledOnce();
    // WebKit must not also run its own selection for a gesture the window now owns.
    expect(event.defaultPrevented).toBe(true);
    drag.remove();
  });

  it("leaves control presses and their default behaviour alone", () => {
    const beginWindowDrag = vi.fn();
    window.__agentDeskBeginWindowDrag = beginWindowDrag;
    const { control } = buildTitlebar();
    const drag = installWindowDrag();

    const event = mouseDown(control);

    expect(beginWindowDrag).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    drag.remove();
  });

  it("survives a control that swallows the event, because it listens in capture", () => {
    const beginWindowDrag = vi.fn();
    window.__agentDeskBeginWindowDrag = beginWindowDrag;
    const { header, title } = buildTitlebar();
    header.addEventListener("mousedown", (event) => event.stopPropagation());
    const drag = installWindowDrag();

    mouseDown(title);

    expect(beginWindowDrag).toHaveBeenCalledOnce();
    drag.remove();
  });

  it("ignores non-primary buttons so the context menu still opens", () => {
    const beginWindowDrag = vi.fn();
    window.__agentDeskBeginWindowDrag = beginWindowDrag;
    const { title } = buildTitlebar();
    const drag = installWindowDrag();

    mouseDown(title, 2);

    expect(beginWindowDrag).not.toHaveBeenCalled();
    drag.remove();
  });

  it("does nothing off the Mac host, where no drag entry point is installed", () => {
    const { title } = buildTitlebar();
    const drag = installWindowDrag();

    const event = mouseDown(title);

    expect(event.defaultPrevented).toBe(false);
    drag.remove();
  });

  it("removes its listener", () => {
    const beginWindowDrag = vi.fn();
    window.__agentDeskBeginWindowDrag = beginWindowDrag;
    const { title } = buildTitlebar();
    const drag = installWindowDrag();

    drag.remove();
    mouseDown(title);

    expect(beginWindowDrag).not.toHaveBeenCalled();
  });
});
