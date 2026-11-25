import { useEffect, useState } from "react";

import { staffQuery } from "@/features/clinic/queries/http";
import type { AppointmentRoutingView } from "@/lib/routing-forms";

/**
 * GET /api/staff/routing-forms/appointment/[id]: how a booking was routed, or null when it was not (or could not be
 * loaded: the card is a bonus on the booking screen, so a failure hides it). A plain effect rather than a query keeps the
 * booking screen usable where no query client is mounted.
 */
export function useAppointmentRouting(appointmentId: string): AppointmentRoutingView | null {
  const [state, setState] = useState<{ id: string; view: AppointmentRoutingView | null } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    staffQuery<AppointmentRoutingView | null>(`/api/staff/routing-forms/appointment/${encodeURIComponent(appointmentId)}`, abort.signal)
      .then((view) => setState({ id: appointmentId, view }))
      .catch(() => {
        if (!abort.signal.aborted) setState({ id: appointmentId, view: null });
      });
    return () => abort.abort();
  }, [appointmentId]);

  return state?.id === appointmentId ? state.view : null;
}
