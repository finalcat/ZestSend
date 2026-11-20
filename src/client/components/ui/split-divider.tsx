import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";

export const SPLIT_RATIO_LIMITS = { max: 75, min: 25 } as const;
export const SPLIT_RATIO_STORAGE_KEY = "zestsend-split-ratio";
export const SPLIT_RATIO_DEFAULT = 40;

export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_LIMITS.max, Math.max(SPLIT_RATIO_LIMITS.min, value));
}

export function readStoredSplitRatio(): number {
  try {
    return clampSplitRatio(Number.parseFloat(window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY) ?? ""));
  } catch {
    return SPLIT_RATIO_DEFAULT;
  }
}

export function storeSplitRatio(value: number): void {
  try {
    window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(clampSplitRatio(value)));
  } catch { /* storage unavailable (private mode) keeps the session ratio */ }
}

/**
 * Vertical drag handle between split panes. Pointer Events with capture so
 * the drag survives leaving the 0.5rem hit area; ratio updates are rAF
 * throttled and committed to localStorage on release.
 */
export function SplitDivider({ ariaLabel, onChange, onCommit, ratio }: {
  ariaLabel: string;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  ratio: number;
}) {
  const frameRef = useRef<number | null>(null);
  const pendingRatioRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const draggingPointerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (draggingPointerRef.current !== null) document.documentElement.classList.remove("zest-split-dragging");
  }, []);

  const scheduleChange = useCallback((value: number) => {
    pendingRatioRef.current = clampSplitRatio(value);
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (pendingRatioRef.current !== null) onChange(pendingRatioRef.current);
    });
  }, [onChange]);

  const ratioFromClientX = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return ratio;
    return ((clientX - rect.left) / rect.width) * 100;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointerRef.current !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
    containerRef.current = event.currentTarget.parentElement;
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingPointerRef.current = event.pointerId;
    document.documentElement.classList.add("zest-split-dragging");
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    scheduleChange(ratioFromClientX(event.clientX));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointerRef.current !== event.pointerId) return;
    draggingPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("zest-split-dragging");
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (pendingRatioRef.current !== null) {
      const final = pendingRatioRef.current;
      pendingRatioRef.current = null;
      onChange(final);
      onCommit(final);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = clampSplitRatio(ratio + delta);
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={SPLIT_RATIO_LIMITS.max}
      aria-valuemin={SPLIT_RATIO_LIMITS.min}
      aria-valuenow={Math.round(ratio)}
      className="zest-split-divider group relative z-10 w-2 shrink-0 cursor-col-resize touch-none"
      onDoubleClick={() => { onChange(50); onCommit(50); }}
      onKeyDown={onKeyDown}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/15 transition-colors duration-150 group-hover:bg-white/40 group-focus-visible:bg-white/60 group-active:bg-sky-300/70" />
    </div>
  );
}
