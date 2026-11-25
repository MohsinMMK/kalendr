// Fills the local Lotus Dental Studio demo clinic with sample doctors, patients and
// bookings dated relative to today: today, tomorrow, the day after, next week and
// next month, plus a few past visits, a waitlist and recalls.
//
// Run after the base seed:  set -a && source .env && set +a && pnpm db:seed:demo
// Re-running moves the bookings to the new "today". Bookings the clinic has already
// acted on (audit events or visit records) are left alone.
import { createHash } from "node:crypto";

import postgres from "postgres";

const databaseUrl = process.env.KALENDR_SEED_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL (source .env) before seeding demo bookings.");
if (!/@(localhost|127\.0\.0\.1|\[::1\]|postgres)(:\d+)?\//.test(databaseUrl)) {
  throw new Error("Demo bookings are only seeded into a local database.");
}

const CLINIC = "lotus-dental";
const IST_OFFSET_MINUTES = 330;
const OPEN = 9 * 60;
const CLOSE = 17 * 60;

function stableId(key) {
  const bytes = createHash("sha256").update(`kalendr-local-demo-v1:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic 0..1 value for a key, so the demo looks the same on every run of a day. */
function rand(key) {
  return createHash("sha256").update(`demo:${key}`).digest().readUInt32BE(0) / 0xffffffff;
}

function pick(key, list) {
  return list[Math.floor(rand(key) * list.length) % list.length];
}

const tenantId = stableId(`tenant:${CLINIC}`);
const locationId = stableId(`location:${CLINIC}`);

// Existing base-seed services 0–1 keep their ids; 2+ are added here.
const services = [
  { index: 0, name: "Dental consultation", duration: 30 },
  { index: 1, name: "Dental cleaning", duration: 45 },
  { index: 2, name: "Root canal treatment", description: "Treatment of an infected tooth, usually over two visits.", duration: 60, mode: "instant" },
  { index: 3, name: "Teeth whitening", description: "In-chair whitening session.", duration: 60, mode: "request" },
  { index: 4, name: "Braces adjustment", description: "Routine orthodontic tightening and check.", duration: 30, mode: "instant" },
  { index: 5, name: "Tooth extraction", description: "Simple or surgical removal of a tooth.", duration: 45, mode: "instant" },
  { index: 6, name: "Child dental check-up", description: "A gentle check-up for children under 14.", duration: 30, mode: "instant" },
];

// Days use 0 = Sunday … 6 = Saturday, matching availability_rules.day_of_week.
const practitioners = [
  { index: 0, name: "Dr Kavya Rao", services: [0, 1, 2, 5], days: [1, 2, 3, 4, 5, 6] },
  { index: 1, name: "Dr Arjun Shah", services: [0, 1, 3], days: [1, 2, 3, 4, 5, 6] },
  { index: 2, name: "Dr Meera Iyer", title: "Orthodontist", initials: "MI", specialty: "Orthodontics", services: [0, 4], days: [1, 3, 5, 6] },
  { index: 3, name: "Dr Rohan Verma", title: "Oral surgeon", initials: "RV", specialty: "Oral surgery", services: [0, 2, 5], days: [2, 4, 6] },
  { index: 4, name: "Dr Fatima Sheikh", title: "Paediatric dentist", initials: "FS", specialty: "Children's dentistry", services: [0, 1, 6], days: [1, 2, 3, 4, 5] },
];

// Each doctor works from their own chair, so chair and doctor bookings never collide.
const chairs = ["Chair 1", "Chair 2", "Chair 3", "Chair 4", "Chair 5"];

const patientNames = [
  ["Ananya", "Rao"], ["Rahul", "Verma"], ["Priya", "Nair"], ["Vikram", "Singh"], ["Sneha", "Kulkarni"],
  ["Aditya", "Menon"], ["Kavita", "Joshi"], ["Imran", "Qureshi"], ["Pooja", "Bhat"], ["Siddharth", "Das"],
  ["Meghna", "Pillai"], ["Arjun", "Malhotra"], ["Divya", "Reddy"], ["Karan", "Mehra"], ["Nisha", "Gupta"],
  ["Farhan", "Ali"], ["Lakshmi", "Iyer"], ["Rohit", "Chawla"], ["Tanvi", "Shetty"], ["Manish", "Agarwal"],
  ["Zoya", "Khan"], ["Harish", "Patel"], ["Ritika", "Sharma"], ["Deepak", "Yadav"], ["Aisha", "Siddiqui"],
  ["Gaurav", "Saxena"], ["Shruti", "Banerjee"], ["Naveen", "Kumar"], ["Isha", "Kapoor"], ["Varun", "Gupta"],
  ["Aarav", "Mehta", true], ["Myra", "Nair", true], ["Kabir", "Singh", true], ["Anika", "Das", true],
  ["Suresh", "Pillai"], ["Rekha", "Menon"],
];
const accessibilityNeeds = { 4: "Uses a wheelchair; needs step-free access.", 18: "Hard of hearing; prefers written instructions.", 34: "Anxious about dental work; book longer slots." };

const patients = patientNames.map(([firstName, lastName, child], index) => ({
  id: stableId(`demo-patient:${CLINIC}:${index}`),
  firstName,
  lastName,
  phone: `+9190000${String(20000 + index).padStart(5, "0")}`,
  email: `${firstName}.${lastName}.${index}@example.com`.toLowerCase(),
  dateOfBirth: child
    ? `${2014 + (index % 6)}-0${1 + (index % 8)}-1${index % 9}`
    : `${1958 + ((index * 7) % 45)}-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + ((index * 3) % 27)).padStart(2, "0")}`,
  channel: pick(`channel:${index}`, ["sms", "whatsapp", "whatsapp", "email"]),
  child: Boolean(child),
  accessibilityNeed: accessibilityNeeds[index] ?? null,
}));
const adultPatients = patients.filter((patient) => !patient.child);
const childPatients = patients.filter((patient) => patient.child);

// --- Dates (clinic time is IST, a fixed +05:30 offset) ---------------------------------
const nowMs = Date.now();
const istNow = new Date(nowMs + IST_OFFSET_MINUTES * 60_000);
const todayUtcMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());

function dayInfo(offset) {
  const midnight = todayUtcMidnight + offset * 86_400_000;
  return { offset, dayOfWeek: new Date(midnight).getUTCDay(), iso: new Date(midnight).toISOString().slice(0, 10) };
}

function clinicInstant(offset, minutes) {
  return new Date(todayUtcMidnight + offset * 86_400_000 + (minutes - IST_OFFSET_MINUTES) * 60_000);
}

// Which days get bookings, and how busy each doctor is on them.
const plan = [
  ...[-21, -14, -9, -7, -6, -5, -3, -2, -1].map((offset) => ({ offset, perDoctor: [1, 2], kind: "past" })),
  { offset: 0, perDoctor: [3, 4], kind: "today" },
  { offset: 1, perDoctor: [4, 5], kind: "soon" },
  { offset: 2, perDoctor: [3, 4], kind: "soon" },
  ...[3, 4, 5, 6].map((offset) => ({ offset, perDoctor: [1, 2], kind: "soon" })),
  ...[7, 8, 9, 10, 11, 12, 13].map((offset) => ({ offset, perDoctor: [2, 3], kind: "next_week" })),
  ...[16, 20, 23, 27, 30, 33, 35, 37, 40, 44].map((offset) => ({ offset, perDoctor: [0, 2], kind: "next_month" })),
];

let patientCursor = 0;
function nextPatient(serviceIndex, key) {
  if (serviceIndex === 6) return childPatients[Math.floor(rand(key) * childPatients.length)];
  const patient = adultPatients[patientCursor % adultPatients.length];
  patientCursor += 1 + Math.floor(rand(key) * 3);
  return patient;
}

function statusFor(day, slotKey, startsAt, endsAt, position, total) {
  const r = rand(`status:${slotKey}`);
  if (day.kind === "past") {
    if (r < 0.08) return { status: "no_show", confirmation: "confirmed" };
    if (r < 0.14) return { status: "cancelled", confirmation: "declined" };
    return { status: "completed", confirmation: "confirmed", form: "submitted" };
  }
  if (day.kind === "today") {
    const ended = endsAt.getTime() <= nowMs;
    const started = startsAt.getTime() <= nowMs;
    // Give the day a few loose ends a front desk would still need to deal with.
    if (position === total - 1 && started) return { status: "checked_in", confirmation: "confirmed", form: "submitted" };
    if (position === total - 2 && started && r < 0.5) return { status: "booked", confirmation: "confirmed", form: "not_started" };
    if (r < 0.07) return { status: "no_show", confirmation: "needs_action" };
    if (r < 0.12) return { status: "cancelled", confirmation: "declined" };
    if (ended) return { status: "completed", confirmation: "confirmed", form: "submitted" };
    if (started) return { status: "checked_in", confirmation: "confirmed", form: "submitted" };
  }
  if (r < 0.06) return { status: "cancelled", confirmation: "declined" };
  const confirmed = rand(`confirm:${slotKey}`) < (day.kind === "next_month" ? 0.35 : day.offset <= 2 ? 0.8 : 0.55);
  const form = day.kind === "next_month"
    ? "not_assigned"
    : pick(`form:${slotKey}`, ["submitted", "submitted", "in_progress", "not_started", "not_assigned"]);
  return { status: "booked", confirmation: confirmed ? "confirmed" : "needs_action", form };
}

const notesPool = [
  "Prefers a morning reminder call.",
  "Sensitive to cold on the lower left molar.",
  "Second sitting of root canal.",
  "Bring previous X-rays.",
  "Insurance pre-approval pending.",
  null, null, null, null, null, null,
];

const appointments = [];
for (const day of plan.map((entry) => ({ ...entry, ...dayInfo(entry.offset) }))) {
  if (day.dayOfWeek === 0) continue;
  for (const doctor of practitioners) {
    if (!doctor.days.includes(day.dayOfWeek)) continue;
    const [low, high] = day.perDoctor;
    const count = low + Math.floor(rand(`count:${day.offset}:${doctor.index}`) * (high - low + 1));
    let minute = OPEN + 15 * Math.floor(rand(`start:${day.offset}:${doctor.index}`) * 4);
    const slots = [];
    for (let position = 0; position < count; position += 1) {
      const slotKey = `${day.offset}:${doctor.index}:${position}`;
      const serviceIndex = pick(`service:${slotKey}`, doctor.services);
      const duration = services[serviceIndex].duration;
      if (minute >= 13 * 60 && minute < 14 * 60) minute = 14 * 60; // lunch
      if (minute + duration > CLOSE) break;
      slots.push({ slotKey, serviceIndex, minute, duration });
      minute += duration + 15 * Math.floor(rand(`gap:${slotKey}`) * 4);
    }
    for (const [position, slot] of slots.entries()) {
      const startsAt = clinicInstant(day.offset, slot.minute);
      const endsAt = clinicInstant(day.offset, slot.minute + slot.duration);
      const patient = nextPatient(slot.serviceIndex, slot.slotKey);
      const outcome = statusFor(day, slot.slotKey, startsAt, endsAt, position, slots.length);
      const service = services[slot.serviceIndex];
      const requested = outcome.status === "booked" && (service.mode === "request" || rand(`request:${slot.slotKey}`) < 0.1);
      const status = requested ? "requested" : outcome.status;
      appointments.push({
        id: stableId(`demo-appointment:${CLINIC}:${slot.slotKey}`),
        patientId: patient.id,
        practitionerId: stableId(`practitioner:${CLINIC}:${doctor.index}`),
        serviceId: stableId(`service:${CLINIC}:${slot.serviceIndex}`),
        resourceId: stableId(`resource:${CLINIC}:${doctor.index}`),
        startsAt,
        endsAt,
        status,
        confirmation: requested ? "needs_action" : outcome.confirmation,
        form: outcome.form ?? "not_assigned",
        reminder: startsAt.getTime() < nowMs ? "delivered" : day.offset <= 1 && !requested ? "queued" : "not_scheduled",
        source: pick(`source:${slot.slotKey}`, ["online", "online", "staff", "staff", "widget", day.kind === "next_month" ? "recall" : "staff"]),
        notes: pick(`notes:${slot.slotKey}`, notesPool),
        cancelledAt: status === "cancelled" ? new Date(startsAt.getTime() - 86_400_000) : null,
      });
    }
  }
}

// --- Write ---------------------------------------------------------------------------
const sql = postgres(databaseUrl, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    const tenant = await tx`SELECT id FROM tenants WHERE id = ${tenantId}`;
    if (!tenant[0]) throw new Error("Run the base local seed first: the Lotus Dental Studio clinic is missing.");
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    for (const service of services.filter((item) => item.index >= 2)) {
      const serviceId = stableId(`service:${CLINIC}:${service.index}`);
      await tx`
        INSERT INTO services (
          id, tenant_id, name, description, duration_minutes, slot_interval_minutes,
          minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, required_resource_kind
        ) VALUES (
          ${serviceId}, ${tenantId}, ${service.name}, ${service.description}, ${service.duration}, 15,
          60, 90, ${service.mode}, ${["new", "returning"]}, 'chair'
        ) ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO service_locations (tenant_id, service_id, location_id)
        VALUES (${tenantId}, ${serviceId}, ${locationId}) ON CONFLICT DO NOTHING
      `;
    }

    for (const [index, name] of chairs.entries()) {
      await tx`
        INSERT INTO resources (id, tenant_id, location_id, name, kind)
        VALUES (${stableId(`resource:${CLINIC}:${index}`)}, ${tenantId}, ${locationId}, ${name}, 'chair')
        ON CONFLICT (id) DO NOTHING
      `;
    }

    for (const doctor of practitioners) {
      const practitionerId = stableId(`practitioner:${CLINIC}:${doctor.index}`);
      if (doctor.index >= 2) {
        await tx`
          INSERT INTO practitioners (id, tenant_id, name, title, initials, specialty, languages, experience_years)
          VALUES (${practitionerId}, ${tenantId}, ${doctor.name}, ${doctor.title}, ${doctor.initials},
            ${doctor.specialty}, 'English, Hindi', ${6 + doctor.index * 3})
          ON CONFLICT (id) DO NOTHING
        `;
        await tx`
          INSERT INTO practitioner_locations (tenant_id, practitioner_id, location_id)
          VALUES (${tenantId}, ${practitionerId}, ${locationId}) ON CONFLICT DO NOTHING
        `;
        for (const dayOfWeek of doctor.days) {
          await tx`
            INSERT INTO availability_rules (
              id, tenant_id, location_id, practitioner_id, day_of_week,
              starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes
            ) VALUES (
              ${stableId(`availability:${CLINIC}:${doctor.index}:${dayOfWeek}`)}, ${tenantId},
              ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00',
              'Asia/Kolkata', '2025-01-01', 15
            ) ON CONFLICT (id) DO NOTHING
          `;
        }
      }
      for (const serviceIndex of doctor.services) {
        await tx`
          INSERT INTO practitioner_services (tenant_id, practitioner_id, service_id)
          VALUES (${tenantId}, ${practitionerId}, ${stableId(`service:${CLINIC}:${serviceIndex}`)})
          ON CONFLICT DO NOTHING
        `;
      }
    }

    for (const patient of patients) {
      await tx`
        INSERT INTO patients (id, tenant_id, first_name, last_name, phone, email, date_of_birth,
          preferred_channel, accessibility_need, is_dependent)
        VALUES (${patient.id}, ${tenantId}, ${patient.firstName}, ${patient.lastName}, ${patient.phone},
          ${patient.email}, ${patient.dateOfBirth}, ${patient.channel}, ${patient.accessibilityNeed}, ${patient.child})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Clear earlier demo bookings that the clinic has not touched, then write this run's set.
    const patientIds = patients.map((patient) => patient.id);
    const appointmentIds = appointments.map((appointment) => appointment.id);
    const removed = await tx`
      DELETE FROM appointments AS appointment
      WHERE appointment.tenant_id = ${tenantId}
        AND appointment.patient_id = ANY(${patientIds})
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE audit_events.appointment_id = appointment.id)
        AND NOT EXISTS (SELECT 1 FROM visit_records WHERE visit_records.appointment_id = appointment.id)
      RETURNING appointment.id
    `;
    const kept = new Set((await tx`
      SELECT id FROM appointments WHERE tenant_id = ${tenantId} AND id = ANY(${appointmentIds})
    `).map((row) => row.id));

    let written = 0;
    for (const appointment of appointments) {
      if (kept.has(appointment.id)) continue;
      await tx`
        INSERT INTO appointments (
          id, tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at,
          status, confirmation_status, booking_source, form_status, reminder_status,
          manage_token_hash, notes, cancelled_at
        ) VALUES (
          ${appointment.id}, ${tenantId}, ${locationId}, ${appointment.patientId}, ${appointment.practitionerId},
          ${appointment.serviceId}, ${appointment.startsAt}, ${appointment.endsAt}, ${appointment.status},
          ${appointment.confirmation}, ${appointment.source}, ${appointment.form}, ${appointment.reminder},
          ${createHash("sha256").update(`demo-manage:${appointment.id}`).digest("hex")},
          ${appointment.notes}, ${appointment.cancelledAt}
        )
      `;
      const state = appointment.status === "cancelled" ? "released" : "confirmed";
      for (const [subject, practitionerId, resourceId] of [
        ["practitioner", appointment.practitionerId, null],
        ["resource", null, appointment.resourceId],
      ]) {
        await tx`
          INSERT INTO resource_reservations (id, tenant_id, appointment_id, practitioner_id, resource_id, starts_at, ends_at, state)
          VALUES (${stableId(`demo-reservation:${appointment.id}:${subject}`)}, ${tenantId}, ${appointment.id},
            ${practitionerId}, ${resourceId}, ${appointment.startsAt}, ${appointment.endsAt}, ${state})
        `;
      }
      written += 1;
    }

    const waitlist = [
      { patient: 7, service: 2, doctors: [3], from: 1, to: 6, time: "morning" },
      { patient: 12, service: 3, doctors: [], from: 2, to: 14, time: "afternoon" },
      { patient: 21, service: 4, doctors: [2], from: 0, to: 10, time: "any" },
      { patient: 31, service: 6, doctors: [4], from: 1, to: 5, time: "afternoon" },
    ];
    for (const [index, entry] of waitlist.entries()) {
      await tx`
        INSERT INTO waitlist_entries (id, tenant_id, patient_id, service_id, location_id, preferred_practitioner_ids, date_from, date_to, time_preference, status)
        VALUES (${stableId(`demo-waitlist:${CLINIC}:${index}`)}, ${tenantId}, ${patients[entry.patient].id},
          ${stableId(`service:${CLINIC}:${entry.service}`)}, ${locationId},
          ${entry.doctors.map((doctor) => stableId(`practitioner:${CLINIC}:${doctor}`))},
          ${dayInfo(entry.from).iso}, ${dayInfo(entry.to).iso}, ${entry.time}, 'active')
        ON CONFLICT (id) DO UPDATE SET date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to, status = 'active'
      `;
    }

    const recalls = [
      { patient: 3, service: 1, due: -10, status: "overdue" },
      { patient: 9, service: 1, due: -1, status: "due" },
      { patient: 15, service: 0, due: 3, status: "due" },
      { patient: 19, service: 1, due: 21, status: "upcoming" },
      { patient: 26, service: 4, due: 30, status: "upcoming" },
    ];
    for (const [index, recall] of recalls.entries()) {
      await tx`
        INSERT INTO recalls (id, tenant_id, patient_id, service_id, due_at, status)
        VALUES (${stableId(`demo-recall:${CLINIC}:${index}`)}, ${tenantId}, ${patients[recall.patient].id},
          ${stableId(`service:${CLINIC}:${recall.service}`)}, ${clinicInstant(recall.due, 10 * 60)}, ${recall.status})
        ON CONFLICT (id) DO UPDATE SET due_at = EXCLUDED.due_at, status = EXCLUDED.status
      `;
    }

    const byKind = {};
    for (const entry of plan) {
      const count = appointments.filter((appointment) => {
        const offset = Math.floor((appointment.startsAt.getTime() + IST_OFFSET_MINUTES * 60_000 - todayUtcMidnight) / 86_400_000);
        return offset === entry.offset;
      }).length;
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + count;
    }
    console.log(`Demo data for Lotus Dental Studio (today is ${dayInfo(0).iso} in clinic time):`);
    console.log(`  ${practitioners.length} doctors, ${services.length} services, ${chairs.length} chairs, ${patients.length} patients`);
    console.log(`  bookings — past: ${byKind.past ?? 0}, today: ${byKind.today ?? 0}, next 6 days: ${byKind.soon ?? 0}, next week: ${byKind.next_week ?? 0}, next month: ${byKind.next_month ?? 0}`);
    console.log(`  ${written} written (${removed.length} earlier demo bookings cleared), ${kept.size} kept because the clinic already acted on them`);
    console.log(`  ${waitlist.length} waitlist entries, ${recalls.length} recalls`);
  });
} finally {
  await sql.end();
}
