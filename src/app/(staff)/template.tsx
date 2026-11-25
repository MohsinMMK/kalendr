import type { ReactNode } from "react";

/**
 * Every staff page settles in the same calm way the customer pages do: a soft fade and a slight rise. A template, not
 * the layout, because Next gives a template a fresh key on each navigation, so the entrance replays when staff move to
 * another page (and not when a filter changes the address). Plain CSS, so it plays before the page is interactive,
 * leaves nothing behind once done, and stays still for people who ask for less motion.
 */
export default function StaffTemplate({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-w-0 motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:animate-in motion-safe:duration-600 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]">
      {children}
    </div>
  );
}
