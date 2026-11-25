"use client";

import { Check, Copy, MailCheck, Link2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { AccountLink } from "@/server/staff-invites";

const expiryFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Shown once after an invite or reset link is made. The link is a one-time key to their account,
 * so it can be copied here when email isn't set up, or to send it on WhatsApp instead.
 */
export function AccessLinkNotice({ link, name, kind = "invite" }: { link: AccountLink; name: string; kind?: "invite" | "reset" }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => toastManager.add({ title: "Link copied", description: `Send it to ${name} yourself.`, type: "success" }),
  });
  const what = kind === "invite" ? "invite" : "password reset link";
  const t = useTerms();
  return (
    <Alert role="status" variant={link.emailed ? "success" : "info"}>
      {link.emailed ? <MailCheck aria-hidden="true" /> : <Link2 aria-hidden="true" />}
      <AlertTitle>{link.emailed ? `${name} has been emailed an ${what}` : `Send ${name} this ${what}`}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          {link.emailed
            ? "They choose their own password from the email. You can also copy the link below."
            : `Email isn't set up for this ${t.business} yet, so copy the link and send it on WhatsApp or by text. It works once.`}
          {" "}Expires {expiryFormat.format(new Date(link.expiresAt))}.
        </p>
        <InputGroup>
          <InputGroupInput readOnly value={link.url} aria-label={`${kind === "invite" ? "Invite" : "Reset"} link for ${name}`} onFocus={(event) => event.currentTarget.select()} />
          <InputGroupAddon align="inline-end">
            <Button size="xs" variant="ghost" onClick={() => copyToClipboard(link.url)}>
              {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </AlertDescription>
    </Alert>
  );
}
