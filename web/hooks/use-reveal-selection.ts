import { useEffect, useRef, type RefObject } from 'react';

/** Reveal the selected panel after React has committed the corresponding navigation. */
export function useRevealSelection(
  key: string | undefined,
  {
    focus = false,
    scroll,
    media,
    onChangeOnly = false,
  }: {
    focus?: boolean;
    scroll?: ScrollLogicalPosition;
    media?: string;
    onChangeOnly?: boolean;
  },
): RefObject<HTMLElement | null> {
  const panel = useRef<HTMLElement>(null);
  const previous = useRef(key);
  useEffect(() => {
    const changed = previous.current !== key;
    previous.current = key;
    if (
      !key ||
      (onChangeOnly && !changed) ||
      (media && !window.matchMedia(media).matches)
    )
      return;
    if (focus) panel.current?.focus({ preventScroll: !!scroll });
    if (scroll) panel.current?.scrollIntoView({ block: scroll });
  }, [key, focus, scroll, media, onChangeOnly]);
  return panel;
}
