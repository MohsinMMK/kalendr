import type { ReactNode } from "react";
import { Check, Clock3, TriangleAlert, X } from "lucide-react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

type StatusTone = "success" | "attention" | "neutral" | "danger" | "info";

const tones: Record<StatusTone, { variant: BadgeProps["variant"]; icon: typeof Check }> = {
  success: { variant: "success", icon: Check },
  attention: { variant: "warning", icon: Clock3 },
  neutral: { variant: "secondary", icon: Clock3 },
  danger: { variant: "error", icon: X },
  info: { variant: "info", icon: TriangleAlert },
};

export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  const { variant, icon: Icon } = tones[tone];
  return (
    <Badge variant={variant} size="lg" className={className}>
      <Icon aria-hidden="true" />
      {children}
    </Badge>
  );
}
