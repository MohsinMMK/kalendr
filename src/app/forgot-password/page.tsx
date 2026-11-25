import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { ForgotPasswordForm } from "@/features/clinic/password-forms";

export const metadata: Metadata = {
  title: "Reset your password",
  description: "Get a link to choose a new password for your Kalendr account.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Link href="/" aria-label="Kalendr home" className="mb-2 inline-flex rounded-md">
            <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          </Link>
          <CardTitle render={<h1 />} className="text-xl">Forgot your password?</CardTitle>
          <CardDescription>Enter your work email and we&apos;ll send you a link to choose a new one.</CardDescription>
        </CardHeader>
        <CardPanel>
          <ForgotPasswordForm />
        </CardPanel>
      </Card>
      <p className="text-center text-xs text-muted-foreground">For business teams · Appointments, organized with care.</p>
    </main>
  );
}
