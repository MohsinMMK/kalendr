import type {
  Appointment,
  AppointmentStatus,
  ContactChannel,
  ConfirmationStatus,
} from "@/lib/domain";

export function appointmentTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function appointmentDay(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

export function appointmentDateTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function appointmentDuration(appointment: Appointment): number {
  return Math.round(
    (new Date(appointment.endsAt).getTime() -
      new Date(appointment.startsAt).getTime()) /
      60_000,
  );
}

export function statusLabel(status: AppointmentStatus): string {
  const labels: Record<AppointmentStatus, string> = {
    requested: "Needs approval",
    booked: "Booked",
    checked_in: "Checked in",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No-show",
    entered_in_error: "Entered in error",
    declined: "Declined",
    expired: "Expired",
    reschedule_requested: "Waiting for a new time",
    pending_payment: "Awaiting payment",
  };
  return labels[status];
}

export function confirmationLabel(status: ConfirmationStatus): string {
  const labels: Record<ConfirmationStatus, string> = {
    needs_action: "Awaiting reply",
    confirmed: "Confirmed",
    declined: "Declined",
  };
  return labels[status];
}

export function channelLabel(channel: ContactChannel): string {
  const labels: Record<ContactChannel, string> = {
    sms: "SMS",
    email: "Email",
    whatsapp: "WhatsApp",
    phone: "Phone call",
  };
  return labels[channel];
}

export function isoClockMinutes(iso: string): number {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}
