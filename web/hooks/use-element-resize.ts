import { useEffect, useEffectEvent, type RefObject } from 'react';

export function useElementResize<T extends HTMLElement>(
  element: RefObject<T | null>,
  onResize: (target: T, rect: DOMRectReadOnly) => void,
): void {
  const resized = useEffectEvent(onResize);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resized(target, entry.contentRect);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
}
