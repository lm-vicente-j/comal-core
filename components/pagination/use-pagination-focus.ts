"use client";

import { useCallback, useEffect, useRef, type FocusEvent } from "react";

const focusable = 'input:not([type="hidden"]), button, a[href], [tabindex="0"]';

function available(element: HTMLElement) {
  return element.isConnected && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible"
    && !element.matches(":disabled")
    && !element.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]');
}

/** Keep the list or picker scope even when a responsive view unmounts. */
export function usePaginationFocus() {
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const context = useRef<{ scope: HTMLElement; pathname: string } | null>(null);

  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    const scope = root.current?.closest<HTMLElement>(
      '[data-pagination-focus-scope], [data-slot="command"], [data-slot="popover-content"], [role="dialog"]'
    );
    if (scope && event.target instanceof HTMLElement) {
      context.current = { scope, pathname: window.location.pathname };
      origin.current = event.target;
    }
  };

  const restoreFocus = useCallback((onlyIfLost = false) => {
    const saved = context.current;
    if (!saved || (onlyIfLost && !origin.current)) return;

    // Radix must finish closing the nested focus scopes and removing aria-hidden.
    window.setTimeout(() => requestAnimationFrame(() => {
      if (onlyIfLost && !origin.current) return;
      const { scope, pathname } = saved;
      if (!scope.isConnected || pathname !== window.location.pathname) return;
      const active = document.activeElement;
      if (onlyIfLost && active instanceof HTMLElement && active !== document.body
        && active !== document.documentElement && available(active)
        && !(active.matches('[role="dialog"]') && active.contains(scope))) return;

      const target = Array.from(scope.querySelectorAll<HTMLElement>(focusable)).find(available);
      target?.focus();
    }), 0);
  }, []);

  useEffect(() => {
    const restoreIfLost = () => {
      if (origin.current) restoreFocus(true);
    };
    const onFocus = (event: globalThis.FocusEvent) => {
      if (event.target === document.body || event.target === document.documentElement) {
        if (origin.current) restoreFocus(true);
        return;
      }
      if (!(event.target instanceof Element)) return;
      const inScope = context.current?.scope.contains(event.target);
      const inPaginationControl = event.target.closest("[data-pagination-dialog]");
      if (event.target !== document.body && event.target !== origin.current && !inScope && !inPaginationControl) {
        origin.current = null;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !root.current?.contains(event.target)
        && !event.target.closest("[data-pagination-dialog]")) origin.current = null;
    };
    window.addEventListener("resize", restoreIfLost);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", restoreIfLost);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onPointerDown);
      restoreIfLost();
    };
  }, [restoreFocus]);

  return { root, rememberFocus, restoreFocus };
}
