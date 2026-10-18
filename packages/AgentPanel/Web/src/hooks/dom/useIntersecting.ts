// Whether an element is within (or near) its scroller's visible part, while both exist.

import { useEffect, useState, type RefObject } from "react";

export function useIntersecting(target: RefObject<Element | null>, root: Element | null, rootMargin: string): boolean {
  const [intersecting, setIntersecting] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element || !root) return;
    const observer = new IntersectionObserver(
      (entries) => setIntersecting(entries.some((entry) => entry.isIntersecting)),
      { root, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, root, rootMargin]);
  return intersecting;
}
