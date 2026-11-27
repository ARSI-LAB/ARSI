import { useEffect, useRef, useState, type RefObject } from 'react';
import { useElementResize } from './use-element-resize';

export interface PolicyViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface PolicyBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitPolicyViewport(
  graph: Pick<PolicyBox, 'width' | 'height'>,
  viewport: Pick<PolicyBox, 'width' | 'height'>,
): PolicyViewportState {
  const zoom = Math.min(
    1,
    Math.max(
      0.08,
      Math.min(
        (viewport.width - 48) / graph.width,
        (viewport.height - 48) / graph.height,
      ),
    ),
  );
  return {
    x: (viewport.width - graph.width * zoom) / 2,
    y: (viewport.height - graph.height * zoom) / 2,
    zoom,
  };
}

export interface CanvasViewportOptions {
  width: number;
  height: number;
  viewport: PolicyViewportState | null;
  onViewport: React.Dispatch<React.SetStateAction<PolicyViewportState | null>>;
  reveal: { token: number; box?: PolicyBox; focusCanvas: boolean } | null;
}

export function useCanvasViewport(
  element: RefObject<HTMLDivElement | null>,
  { width, height, viewport, onViewport, reveal }: CanvasViewportOptions,
): { state: PolicyViewportState; size: { width: number; height: number } } {
  const [size, setSize] = useState({ width: 800, height: 580 });
  const state = viewport ?? fitPolicyViewport({ width, height }, size);
  const lastReveal = useRef<number | null>(null);

  useElementResize(element, (_target, rect) =>
    setSize({ width: rect.width, height: rect.height }),
  );

  useEffect(() => {
    const target = element.current;
    if (!target) return;

    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      onViewport((previous) => {
        const current = previous ?? fitPolicyViewport({ width, height }, size);
        const zoom = Math.max(0.08, Math.min(2, current.zoom * factor));
        if (zoom === current.zoom) return previous;
        const ratio = zoom / current.zoom;
        return {
          zoom,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    };

    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => target.removeEventListener('wheel', handleWheel);
  }, [element, width, height, size, onViewport]);

  useEffect(() => {
    const target = element.current;
    if (!target || !reveal || lastReveal.current === reveal.token) return;
    lastReveal.current = reveal.token;
    if (reveal.box) {
      const zoom = Math.max(state.zoom, 0.65);
      onViewport({
        zoom,
        x:
          target.clientWidth / 2 - (reveal.box.x + reveal.box.width / 2) * zoom,
        y:
          target.clientHeight / 2 -
          (reveal.box.y + Math.min(reveal.box.height, 120) / 2) * zoom,
      });
    }
    if (reveal.focusCanvas) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [element, reveal, onViewport, state.zoom]);

  return { state, size };
}
