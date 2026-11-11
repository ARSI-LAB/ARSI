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
  onViewport: (next: PolicyViewportState) => void;
  reveal: { token: number; box: PolicyBox } | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    viewport: PolicyViewportState;
  } | null>(null);
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
    if (!reveal || lastReveal.current === reveal.token) return;
    lastReveal.current = reveal.token;
    const zoom = Math.max(state.zoom, 0.65);
    onViewport({
      zoom,
      x: size.width / 2 - (reveal.box.x + reveal.box.width / 2) * zoom,
      y:
        size.height / 2 -
        (reveal.box.y + Math.min(reveal.box.height, 120) / 2) * zoom,
    });
  }, [reveal, onViewport, state.zoom, size]);

  function zoomBy(
    factor: number,
    center = { x: size.width / 2, y: size.height / 2 },
  ): void {
    const zoom = Math.max(0.08, Math.min(2, state.zoom * factor));
    onViewport({
      zoom,
      x: center.x - ((center.x - state.x) * zoom) / state.zoom,
      y: center.y - ((center.y - state.y) * zoom) / state.zoom,
    });
  }

  return (
    <div className="policy-canvas-shell">
      <div className="policy-canvas-tools" aria-label="Graph navigation">
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <span aria-live="polite">{Math.round(state.zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          aria-label="Zoom out"
        >
          −
        </button>
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
        aria-label="Policy graph. Drag the background to pan. Use arrow keys to pan, plus or minus to zoom, and Home to fit."
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
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            zoomBy(1.2);
          } else if (event.key === '-') {
            event.preventDefault();
            zoomBy(1 / 1.2);
          } else if (event.key === 'Home') {
            event.preventDefault();
            onViewport(fitPolicyViewport({ width, height }, size));
          }
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target instanceof Element &&
              event.target.closest('button, a'))
          )
            return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            viewport: state,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          onViewport({
            ...start.viewport,
            x: start.viewport.x + event.clientX - start.x,
            y: start.viewport.y + event.clientY - start.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
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
        Drag background or use arrow keys to pan · + / − to zoom · Home to fit
      </p>
    </div>
  );
}
