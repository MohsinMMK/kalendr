import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A coss Button laid out as a multi-line list row or selection card. */
export function RowButton({ className, variant = "ghost", ...props }: ButtonProps) {
  return (
    <Button
      variant={variant}
      className={cn(
        "h-auto w-full justify-start whitespace-normal text-left text-sm font-normal sm:h-auto sm:text-sm",
        // Ghost's transparent border would otherwise hide the divider between rows in a list.
        variant === "ghost" && "rounded-none border-x-0 border-t-0 not-last:border-b-border",
        className,
      )}
      {...props}
    />
  );
}
