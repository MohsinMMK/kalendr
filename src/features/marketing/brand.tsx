import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

/** The logo's width over its height: the calendar K mark in public/kalendr-logo.svg. */
const LOGO_RATIO = 865 / 679;

/** The Kalendr wordmark: the calendar K mark beside the name. `size` is the mark's height in pixels. */
export function Brand({ size = 24, className }: { size?: number; className?: string }) {
  const width = Math.round(size * LOGO_RATIO);
  return (
    <Link
      href="/"
      aria-label="Kalendr home"
      className={cn(
        "inline-flex items-center gap-2 font-heading text-xl font-extrabold tracking-tight text-foreground no-underline",
        className,
      )}
    >
      <Image src="/kalendr-logo.svg" width={width} height={size} alt="" className="dark:hidden" />
      <Image src="/kalendr-logo-white.svg" width={width} height={size} alt="" className="hidden dark:block" />
      Kalendr
    </Link>
  );
}
