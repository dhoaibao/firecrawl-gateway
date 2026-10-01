import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Restores keyboard focus to whatever opened a controlled Radix overlay.
 * Radix only restores focus to a mounted Trigger, so wrappers opened by state
 * (not a Trigger) capture the opener here and hand it back on close.
 * Pass the returned handler to the content's `onCloseAutoFocus`.
 */
export function useReturnFocus(open: boolean) {
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement;
    }
  }, [open]);

  return useCallback((event: Event) => {
    event.preventDefault();
    const opener = openerRef.current;
    openerRef.current = null;
    // An opener can be connected yet unfocusable (disabled, or hidden at another
    // breakpoint), so verify the focus actually moved before falling back.
    opener?.focus({ preventScroll: true });
    if (!opener || document.activeElement !== opener) {
      document.getElementById("content")?.focus({ preventScroll: true });
    }
  }, []);
}
