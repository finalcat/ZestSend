import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars";

import { cn } from "@/lib/utils";

export const VERTICAL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-zestsend",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export function shouldUseNativeScrollbars(): boolean {
  if (typeof navigator === "undefined") return false;

  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const vendor = navigator.vendor || "";
  const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(platform) || /iPhone|iPad|iPod/i.test(userAgent);
  const isSafari = /Safari/i.test(userAgent) && /Apple/i.test(vendor) && !/Android|Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Opera/i.test(userAgent);

  return isApplePlatform || isSafari;
}

export function prepareNativeScrollbarHost(host: HTMLElement): boolean {
  if (!shouldUseNativeScrollbars()) return false;
  host.removeAttribute("data-overlayscrollbars-initialize");
  return true;
}

type OverlayScrollbarProps = ComponentPropsWithoutRef<"div"> & {
  options?: PartialOptions;
  /**
   * Lays the scroll content out bottom-up (chat-style): the scroller anchors
   * at the newest entry and grows upward, so scrollTop 0 means "at the
   * bottom" natively. Applied to both host and viewport because either can
   * be the real scrolling element (OverlayScrollbars mode vs the
   * Apple/Safari native-scrollbar fallback).
   */
  reverse?: boolean;
  syncKey?: string | number | boolean | null;
};

export function OverlayScrollbar({
  children,
  className,
  options = VERTICAL_SCROLLBAR_OPTIONS,
  reverse = false,
  syncKey,
  ...props
}: OverlayScrollbarProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport || prepareNativeScrollbarHost(host)) return;

    const existing = OverlayScrollbars(host);
    const instance = existing ?? OverlayScrollbars({
      target: host,
      elements: {
        content: false,
        padding: false,
        viewport,
      },
    }, options);
    if (existing) existing.options(options);
    instanceRef.current = instance;

    return () => {
      if (!existing) instance.destroy();
      if (instanceRef.current === instance) instanceRef.current = null;
    };
  }, [options]);

  useEffect(() => {
    instanceRef.current?.update(true);
  }, [syncKey]);

  return (
    <div
      {...props}
      ref={hostRef}
      className={cn("overflow-y-auto", reverse && "flex flex-col-reverse", className)}
      data-overlayscrollbars-initialize=""
    >
      <div className={cn("h-full min-h-full", reverse && "flex shrink-0 flex-col-reverse")} ref={viewportRef}>
        {children}
      </div>
    </div>
  );
}
