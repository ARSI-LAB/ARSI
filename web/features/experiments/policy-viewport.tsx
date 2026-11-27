import React, { useRef, useState } from 'react';
import {
  useCanvasViewport,
  fitPolicyViewport,
  type CanvasViewportOptions,
  type PolicyViewportState,
} from '../../hooks/use-canvas-viewport';

const panThreshold = 6;

export function PolicyViewport({
  width,
  height,
  viewport,
  onViewport,
  reveal,
  children,
}: CanvasViewportOptions & {
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
  const { size, state } = useCanvasViewport(element, {
    width,
    height,
    viewport,
    onViewport,
    reveal,
  });

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
