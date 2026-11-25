"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

/** The calendar library loads when a week or column layout is first shown, not with the rest of the booking page. */
export const KloqPickerLoader = dynamic(() => import("./kloq-picker"), {
  ssr: false,
  loading: () => <Skeleton className="h-[32rem] max-h-[75dvh] w-full rounded-xl" />,
});
