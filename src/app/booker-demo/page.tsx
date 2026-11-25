import { demoClinic } from "@/lib/demo-data";

import { DemoBooker } from "./demo-booker";

export const metadata = {
  title: "Booker component demo",
  description: "The Kalendr Booker React component booking through the public API.",
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default async function BookerDemoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { business } = await searchParams;
  const clinicSlug = typeof business === "string" && slugPattern.test(business) ? business : demoClinic.slug;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="font-heading font-semibold text-2xl">Booker component</h1>
      <p className="max-w-2xl text-muted-foreground text-sm">
        This page uses the <code>Booker</code> component from <code>packages/booker</code>. It lists services, finds times and books through the public API, with no iframe.
      </p>
      <DemoBooker clinicSlug={clinicSlug} />
    </main>
  );
}
