import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { practitionerInitials } from "@/lib/clinic-slug";
import { cn } from "@/lib/utils";

/** The one way the app shows a person: their photo when there is one, otherwise their initials. */
export function PersonAvatar({ name, image, className }: { name: string; image?: string | null; className?: string }) {
  return (
    <Avatar className={cn("size-8 shrink-0", className)}>
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback aria-hidden="true">{practitionerInitials(name).slice(0, 2)}</AvatarFallback>
    </Avatar>
  );
}
