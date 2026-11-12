import React, { useEffect, useRef, useState } from 'react';

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

const panThreshold = 6;

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

export function PolicyViewport({
  width,
  height,
  viewport,
  onViewport,
  reveal,
  children,
}: {
  width: number;
  height: number;
  viewport: PolicyViewportState | null;
  onViewport: React.Dispatch<React.SetStateAction<PolicyViewportState | null>>;
  reveal: { token: number; box?: PolicyBox; focusCanvas: boolean } | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    viewport: PolicyViewportState;
    panning: boolean;
    capture: Element;
  } | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 580 });
  const state = viewport ?? fitPolicyViewport({ width, height }, size);
  const lastReveal = useRef<number | null>(null);

  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

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
  }, [width, height, size, onViewport]);

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
  }, [reveal, onViewport, state.zoom]);

  function endGesture(pointerId: number): void {
    if (drag.current?.pointerId !== pointerId) return;
    if (drag.current.panning) setPanning(false);
    drag.current = null;
  }

  return (
    <div className="policy-canvas-shell">
      <div className="policy-canvas-tools" aria-label="Graph navigation">
        <span aria-live="polite">{Math.round(state.zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => onViewport(fitPolicyViewport({ width, height }, size))}
        >
          Fit to view
        </button>
        <button type="button" onClick={() => onViewport({ ...state, zoom: 1 })}>
          100%
        </button>
      </div>
      <div
        ref={element}
        className="policy-canvas"
        tabIndex={0}
        role="region"
        data-panning={panning}
        aria-label="Policy graph. Drag or use arrow keys to pan. Hold Ctrl and scroll to zoom. Press Home to fit."
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [60, 0],
            ArrowRight: [-60, 0],
            ArrowUp: [0, 60],
            ArrowDown: [0, -60],
          };
          const movement = delta[event.key];
          if (movement) {
            event.preventDefault();
            onViewport({
              ...state,
              x: state.x + movement[0],
              y: state.y + movement[1],
            });
          } else if (event.key === 'Home') {
            event.preventDefault();
            onViewport(fitPolicyViewport({ width, height }, size));
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || drag.current) return;
          suppressClick.current = false;
          const control =
            event.target instanceof Element
              ? event.target.closest('button, a')
              : null;
          if (!control) event.currentTarget.focus({ preventScroll: true });
          const capture = control ?? event.currentTarget;
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            viewport: state,
            panning: false,
            capture,
          };
          // Keep taps on the original control until the canvas takes over a drag.
          capture.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.panning) {
            if (Math.hypot(dx, dy) < panThreshold) return;
            start.panning = true;
            suppressClick.current = true;
            setPanning(true);
            event.currentTarget.focus({ preventScroll: true });
            start.capture = event.currentTarget;
            start.capture.setPointerCapture(event.pointerId);
          }
          onViewport({
            ...start.viewport,
            x: start.viewport.x + dx,
            y: start.viewport.y + dy,
          });
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          if (start?.pointerId !== event.pointerId) return;
          if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) >=
            panThreshold
          )
            suppressClick.current = true;
          endGesture(event.pointerId);
        }}
        onPointerCancel={(event) => endGesture(event.pointerId)}
        onLostPointerCapture={(event) => {
          if (event.target === drag.current?.capture)
            endGesture(event.pointerId);
        }}
        onClickCapture={(event) => {
          // Keyboard activation does not belong to a pointer gesture.
          if (!suppressClick.current || event.detail === 0) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          className="policy-canvas-content"
          style={{
            width,
            height,
            transform: `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`,
          }}
        >
          {children}
        </div>
      </div>
      <p className="policy-canvas-hint">
        Drag or press arrows to pan · Ctrl + scroll to zoom · Home to fit
      </p>
    </div>
  );
}
