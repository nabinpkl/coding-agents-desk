import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanvasStoreContext,
  createCanvasStore,
  useRevealWhenAsked,
  type CanvasStore,
} from "@/features/bots/canvas/canvasStore";

const scrolled = vi.fn();

// The card's own ref, as `BotSessionCard` attaches it: a stand-in that renews the callback on every
// render would scroll for reasons the card never has.
function Card({ sessionKey }: { sessionKey: string }) {
  return (
    <div ref={useRevealWhenAsked(sessionKey)} data-key={sessionKey}>
      <div data-ringed={sessionKey} />
    </div>
  );
}

const ringed = vi.fn();

const ownScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled(this.dataset.key);
  };
  HTMLElement.prototype.animate = function (this: HTMLElement) {
    ringed(this.dataset.ringed);
    return {} as Animation;
  };
});

function Canvas({ store, cards }: { store: CanvasStore; cards: string[] }) {
  return (
    <CanvasStoreContext.Provider value={store}>
      {cards.map((key) => (
        <Card key={key} sessionKey={key} />
      ))}
    </CanvasStoreContext.Provider>
  );
}

afterEach(() => {
  scrolled.mockReset();
  ringed.mockReset();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  if (ownScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", ownScroll);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("useRevealWhenAsked", () => {
  it("scrolls a card that is already drawn when it is asked for, once", () => {
    const store = createCanvasStore();
    const view = render(<Canvas store={store} cards={["claude:a", "claude:b"]} />);
    act(() => store.getState().reveal("claude:b"));
    view.rerender(<Canvas store={store} cards={["claude:a", "claude:b"]} />);
    expect(scrolled.mock.calls).toEqual([["claude:b"]]);
    expect(store.getState().revealKey).toBeNull();
  });

  // Rings the card's own box, the one with the rounded edge, and only the card asked for.
  it("rings the card it scrolled to, once", () => {
    const store = createCanvasStore();
    const view = render(<Canvas store={store} cards={["claude:a", "claude:b"]} />);
    act(() => store.getState().reveal("claude:b"));
    view.rerender(<Canvas store={store} cards={["claude:a", "claude:b"]} />);
    expect(ringed.mock.calls).toEqual([["claude:b"]]);
  });

  // The order the page uses when a Bot comes back on the canvas: asked first, drawn after.
  it("scrolls a card drawn after it was asked for, when it arrives", () => {
    const store = createCanvasStore();
    const view = render(<Canvas store={store} cards={["claude:a"]} />);
    act(() => store.getState().reveal("claude:c"));
    expect(scrolled).not.toHaveBeenCalled();
    view.rerender(<Canvas store={store} cards={["claude:a", "claude:c"]} />);
    expect(scrolled.mock.calls).toEqual([["claude:c"]]);
    expect(store.getState().revealKey).toBeNull();
  });

  it("forgets a card the reader stopped waiting for", () => {
    const store = createCanvasStore();
    const view = render(<Canvas store={store} cards={[]} />);
    act(() => store.getState().reveal("claude:d"));
    act(() => store.getState().dropReveal());
    view.rerender(<Canvas store={store} cards={["claude:d"]} />);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("leaves a newer ask waiting when an older one is answered", () => {
    const store = createCanvasStore();
    store.getState().reveal("claude:e");
    store.getState().reveal("claude:f");
    store.getState().revealed("claude:e");
    expect(store.getState().revealKey).toBe("claude:f");
  });
});
