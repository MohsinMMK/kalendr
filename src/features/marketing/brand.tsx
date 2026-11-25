import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

export function Brand({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Kalendr home"
      className={cn(
        "inline-flex items-center gap-2 font-heading text-xl font-semibold text-foreground no-underline",
        className,
      )}
    >
      <Image src="/kalendr-mark.svg" width={size} height={size} alt="" />
      kalendr
    </Link>
  );
}
