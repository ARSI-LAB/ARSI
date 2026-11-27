import { useEffect, useEffectEvent, useState, type RefObject } from 'react';

/** Observe the mounted end marker and rearm it when a different page is shown. */
export function useLoadBoundary(
  root: RefObject<HTMLDivElement | null>,
  pageKey: string,
  loadMore: () => void,
): (node: HTMLDivElement | null) => void {
  const [marker, setMarker] = useState<HTMLDivElement | null>(null);
  const onVisible = useEffectEvent(loadMore);
  useEffect(() => {
    if (!marker || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onVisible();
      },
      { root: root.current, rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [root, pageKey, marker]);
  return setMarker;
}
