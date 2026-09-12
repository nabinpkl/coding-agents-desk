"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * A textarea that grows with its content instead of scrolling inside a fixed single row.
 *
 * Two measurements make this correct rather than approximately correct. `scrollHeight` is the
 * PADDING box and these fields are `border-box`, so the border has to be added back; without it
 * every field sits exactly its own border short of its content, which is visible immediately:
 * an empty field scrolls its placeholder, and the last pixels of a draft's final line are clipped.
 * And the growth is clamped at the element's own `max-height` rather than left for the cascade to
 * clamp, so a draft past the cap stops producing new heights -- otherwise every keystroke rewrites
 * the height, and the `auto` probe each rewrite needs resets the scroll away from the caret.
 *
 * Re-measured on the two things that change the wrap: the text, and the field's width (the sidebar
 * divider and the window both rewrap a draft without changing a character of it).
 */
export function useAutoGrowingTextArea(value: string): (element: HTMLTextAreaElement | null) => void {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const border = element.offsetHeight - element.clientHeight;
    const cap = Number.parseFloat(getComputedStyle(element).maxHeight);
    const scrolled = element.scrollTop;
    element.style.height = "auto";
    const content = element.scrollHeight;
    // jsdom measures every box at zero. Writing that would collapse the field, so a degenerate
    // measurement hands the height back to the element's own `min-h`/`max-h` utilities.
    element.style.height = content > 0
      ? `${Math.min(content + border, Number.isNaN(cap) ? Infinity : cap)}px`
      : "";
    element.scrollTop = scrolled;
  }, []);

  useEffect(measure, [measure, value]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // Width only. Observing the field it also resizes would otherwise feed its own height changes
    // back in as fresh observations. Starts unset rather than at a measured width, because the
    // observer reports the content box and nothing here has read that box yet.
    let observed: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === observed) return;
      const first = observed === null;
      observed = width;
      if (!first) measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return useCallback(
    (element: HTMLTextAreaElement | null) => {
      ref.current = element;
      measure();
    },
    [measure],
  );
}
