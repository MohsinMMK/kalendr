import { QueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { StaffQueryProvider } from "@/features/clinic/queries/client";

/** A cache of its own for one test: nothing is retried, so a failure shows at once. */
export function TestQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity }, mutations: { retry: false } } }));
  return <StaffQueryProvider scope="test" client={client}>{children}</StaffQueryProvider>;
}
