import React, { useEffect, useRef, useState } from 'react';

const minDetailsWidth = 230;
const maxDetailsWidth = 720;
const minGraphWidth = 300;
const keyboardStep = 24;

export function PolicyWorkspace({
  children,
  details,
  detailsId,
  fullData,
  hasSelection,
  inputFocus,
}: {
  children: React.ReactNode;
  details: React.ReactNode;
  detailsId: string;
  fullData: boolean;
  hasSelection: boolean;
  inputFocus: boolean;
}): React.JSX.Element {
  const workspace = useRef<HTMLDivElement>(null);
  const resizer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const [dimensions, setDimensions] = useState<{
    available: number;
    defaultWidth: number;
  } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);

  useEffect(() => {
    const target = workspace.current;
    const divider = resizer.current;
    if (!target || !divider) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setDimensions({
        available: Math.max(
          0,
          Math.floor(entry.contentRect.width) - divider.offsetWidth,
        ),
        defaultWidth: parseFloat(
          getComputedStyle(target).getPropertyValue('--policy-detail-default'),
        ),
      });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const maxWidth = dimensions
    ? Math.min(
        maxDetailsWidth,
        dimensions.available -
          Math.min(minGraphWidth, Math.round(dimensions.available * 0.45)),
      )
    : maxDetailsWidth;
  const minWidth = Math.min(minDetailsWidth, maxWidth);
  const clampWidth = (width: number): number =>
    Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
  const width = dimensions
    ? clampWidth(preferredWidth ?? dimensions.defaultWidth)
    : undefined;
  const style:
    | (React.CSSProperties & { '--policy-detail-width': string })
    | undefined =
    width === undefined ? undefined : { '--policy-detail-width': `${width}px` };

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <div
      ref={workspace}
      className="policy-workspace"
      data-full-data={fullData}
      data-has-selection={hasSelection}
      data-input-focus={inputFocus}
      style={style}
    >
      {children}
      <div
        ref={resizer}
        className="policy-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize policy details"
        aria-orientation="vertical"
        aria-controls={detailsId}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        aria-valuetext={width === undefined ? undefined : `${width} pixels`}
        onKeyDown={(event) => {
          if (width === undefined) return;
          let next: number;
          switch (event.key) {
            case 'ArrowLeft':
              next = width + keyboardStep;
              break;
            case 'ArrowRight':
              next = width - keyboardStep;
              break;
            case 'Home':
              next = minWidth;
              break;
            case 'End':
              next = maxWidth;
              break;
            default:
              return;
          }
          event.preventDefault();
          setPreferredWidth(clampWidth(next));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || width === undefined || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          setPreferredWidth(clampWidth(start.width + start.x - event.clientX));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      {details}
    </div>
  );
}
