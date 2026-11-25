"use client";

import { animate, stagger, useReducedMotion } from "motion/react";
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/** One feel for the whole booking: unhurried, settling softly at the end. */
export const calmEase = [0.22, 1, 0.36, 1] as const;
export const calm = { duration: 0.55, ease: calmEase } as const;

/**
 * Plays a soft entrance on what is already on screen whenever `key` changes (a new week, a new day), without
 * remounting it, so focus, the roving tab stop and anything else the element owns stay put. Nothing plays on the
 * first paint, or for people who ask for less motion.
 *
 * `selector` picks the parts that arrive one after another (day columns, for instance); without it the element
 * arrives as one. With `directional`, keys that sort in time order (`YYYY-MM-DD`) slide in from the side they come
 * from: later from the right, earlier from the left. Otherwise it rises gently into place.
 */
export function useEntrance(ref: RefObject<HTMLElement | null>, key: string, options: { selector?: string; directional?: boolean } = {}) {
  const reduce = useReducedMotion();
  const previous = useRef<string | null>(null);
  const { selector, directional = false } = options;
  useEffect(() => {
    // Same key (the first paint, or React running the effect twice in development): nothing new arrived.
    const before = previous.current;
    const changed = before !== null && before !== key;
    previous.current = key;
    const element = ref.current;
    if (!changed || reduce || !element) return;
    const targets = selector ? [...element.querySelectorAll<HTMLElement>(selector)] : [element];
    if (targets.length === 0) return;
    const side = directional && before !== null ? (key > before ? 1 : -1) : 0;
    // Opacity and movement share timing, so the browser tests' "wait for animations" covers the whole entrance.
    const controls = animate(
      targets,
      { opacity: [0, 1], transform: [side ? `translateX(${side * 14}px)` : "translateY(6px)", "none"] },
      { ...calm, delay: targets.length > 1 ? stagger(0.035) : 0 },
    );
    // Once settled, leave no inline transform behind (it would make each part its own stacking context).
    void controls.then(() => {
      for (const target of targets) {
        target.style.removeProperty("transform");
        target.style.removeProperty("opacity");
      }
    });
    // If something newer arrives mid-way, finish this one rather than leave it half faded.
    return () => controls.complete();
  }, [key, reduce, selector, directional, ref]);
}

const noSubscribe = () => () => {};

/** False on the server and while the page hydrates, true after: entrances never hide the first paint. */
export function useHydrated() {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** A value that changed eases in: used for the plain text of the booking panel's rows. */
export const valueEntrance = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: calm } as const;
