// Adds B-One Clinic, a local demo polyclinic in Tolichowki, Hyderabad: 5 doctors of different
// specialities, 11 services, 5 consultation rooms, 30 customers and 90 bookings spread over
// today, tomorrow and the day after (30 a day, 6 per doctor).
//
// Local database only. The owner sign-in is written to .local-db/b-one-clinic-owner.json
// (gitignored); re-running keeps that password and moves the bookings to the new "today".
//
//   set -a; source .local-db/database.env; set +a
//   KALENDR_SEED_DATABASE_URL="postgresql://nira_local_owner:$NIRA_LOCAL_OWNER_PASSWORD@127.0.0.1:5544/nira_local" \
//     node scripts/seed-polyclinic.mjs
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

const databaseUrl = process.env.KALENDR_SEED_DATABASE_URL;
if (!databaseUrl) throw new Error("Set KALENDR_SEED_DATABASE_URL to the local owner URL.");
if (!/@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(databaseUrl)) {
  throw new Error("The polyclinic demo is only seeded into a local database.");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialsPath = resolve(projectRoot, ".local-db/b-one-clinic-owner.json");

const CLINIC = "b-one-clinic";
const IST_OFFSET_MINUTES = 330;

function stableId(key) {
  const bytes = createHash("sha256").update(`kalendr-local-demo-v1:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rand(key) {
  return createHash("sha256").update(`polyclinic:${key}`).digest().readUInt32BE(0) / 0xffffffff;
}

function pick(key, list) {
  return list[Math.floor(rand(key) * list.length) % list.length];
}

const tenantId = stableId(`tenant:${CLINIC}`);
const locationId = stableId(`location:${CLINIC}`);
const clinic = {
  slug: CLINIC,
  name: "B-One Clinic",
  legalName: "B-One Clinic (Local Demo)",
  phone: "+919000000404",
  email: "b-one-clinic@example.com",
  locationName: "Tolichowki",
  // From the clinic's Google Maps listing (17.3989831, 78.4109549).
  // The app adds the city after the address, so the address stops before "Hyderabad".
  address: "7 Tombs Rd, Aditya Nagar Colony, Surya Nagar, Toli Chowki, Telangana 500008",
  city: "Hyderabad",
  about: "A neighbourhood polyclinic in Tolichowki: general physician (family doctor), paediatrics, gynaecology and dermatology, with blood tests and discounted medicines. Appointment required.",
};
const owner = { name: "Mohammed Irfan", email: "b-one.owner@example.com" };

// Prices are in paise (INR minor units).
const services = [
  // ₹100 consultation fee is from a Google review (Mahammad Kousar, 2026). Other prices are demo values.
  { key: "gp", name: "General physician consultation", category: "General medicine", duration: 20, price: 10000, description: "Family doctor visit: fever, cough, BP, sugar and other everyday health concerns." },
  { key: "health-check", name: "Basic health check-up", category: "General medicine", duration: 40, price: 120000, description: "Full examination with a review of blood test reports." },
  { key: "follow-up", name: "Follow-up visit", category: "All specialities", duration: 15, price: 30000, description: "A review visit within 14 days of an earlier consultation." },
  { key: "child", name: "Child consultation", category: "Paediatrics", duration: 20, price: 60000, description: "For babies, children and teenagers up to 16." },
  { key: "vaccination", name: "Child vaccination", category: "Paediatrics", duration: 15, price: 40000, description: "Scheduled vaccines with a short check-up. Vaccine charged separately." },
  { key: "gynae", name: "Gynaecology consultation", category: "Obstetrics & gynaecology", duration: 25, price: 70000, description: "Periods, PCOS, fertility and other women's health concerns." },
  { key: "antenatal", name: "Antenatal check-up", category: "Obstetrics & gynaecology", duration: 25, price: 70000, description: "Routine pregnancy check-up." },
  // Reviews say the clinic "even perform[s] blood tests".
  { key: "blood-test", name: "Blood test sample collection", category: "Lab tests", duration: 10, price: 20000, description: "Blood sample for sugar, CBC, thyroid and other routine tests. Test charges extra." },
  { key: "skin", name: "Skin consultation", category: "Dermatology", duration: 20, price: 60000, description: "Acne, rashes, allergies, hair fall and nail problems." },
  { key: "acne", name: "Acne and scar treatment", category: "Dermatology", duration: 30, price: 150000, description: "Chemical peel or scar treatment session after a consultation." },
];
// Earlier versions of this seed added these; nothing in the research supports them.
const retiredServiceKeys = ["ortho", "dressing"];
const serviceByKey = Object.fromEntries(services.map((service) => [service.key, service]));
const serviceId = (key) => stableId(`service:${CLINIC}:${key}`);

// Research, 2026-11-24 (Google Maps listing and its reviews; no Practo/Justdial/website found):
// - Dr Mohammed Khaleed: general physician / family doctor. His board in the owner's photo reads
//   "MBBS, FC… General Physician, 6:00 pm To 10:00 pm" (the rest is unreadable).
// - Dr Shaik Sajid Hussain: sees children at B-One Polyclinic (three reviews from 2026-11-24).
// - A review says the clinic has "specialised doctors in pediatric, gynaecologist, dermatologist, ......"
//   and does blood tests. The gynaecologist and dermatologist are not named anywhere, so the two
//   names below are PLACEHOLDERS, as is everything not listed above (years, languages).
// Blood tests are a service of the general physician, not a practitioner of their own.
// `perDay` is each doctor's visits a day; together they make 30 (one per customer).
const doctors = [
  { index: 0, name: "Dr Mohammed Khaleed", title: "General physician", initials: "MK", specialty: "General medicine", qualifications: "MBBS", languages: "English, Urdu, Hindi, Telugu", years: null, services: ["gp", "gp", "gp", "health-check", "follow-up", "blood-test"], perDay: 10, room: "Consultation room 1" },
  { index: 1, name: "Dr Shaik Sajid Hussain", title: "Paediatrician", initials: "SH", specialty: "Paediatrics", qualifications: null, languages: "English, Urdu, Hindi", years: null, services: ["child", "child", "vaccination", "follow-up"], perDay: 6, room: "Consultation room 2" },
  { index: 2, name: "Dr Lakshmi Reddy", title: "Obstetrician and gynaecologist", initials: "LR", specialty: "Obstetrics & gynaecology", qualifications: "MBBS, MS (OBG)", languages: "English, Telugu, Hindi", years: 15, services: ["gynae", "gynae", "antenatal", "follow-up"], perDay: 6, room: "Consultation room 3" },
  { index: 4, name: "Dr Ayesha Siddiqua", title: "Dermatologist", initials: "AS", specialty: "Dermatology", qualifications: "MBBS, MD (Dermatology)", languages: "English, Urdu, Hindi", years: 8, services: ["skin", "skin", "acne", "follow-up"], perDay: 8, room: "Consultation room 4" },
];
// Practitioner slots earlier versions of this seed used (3 was an orthopaedic surgeon, then "B-One Lab").
const retiredDoctorIndexes = [3];
const doctorId = (doctor) => stableId(`practitioner:${CLINIC}:${doctor.index}`);
const roomId = (doctor) => stableId(`resource:${CLINIC}:${doctor.index}`);
// Mon–Sat (ISO 1–6), morning and evening OPD, as most Hyderabad clinics run.
const sessions = [["10:00", "14:00"], ["17:00", "21:00"]];

// 12 women, 12 men, 6 children: the children see the paediatrician, women fill the gynaecology list.
const people = [
  ["Ayesha", "Begum", "F"], ["Farah", "Naaz", "F"], ["Sana", "Mirza", "F"], ["Swathi", "Reddy", "F"],
  ["Nikhat", "Parveen", "F"], ["Divya", "Rao", "F"], ["Rukhsar", "Khan", "F"], ["Anjali", "Varma", "F"],
  ["Heena", "Kausar", "F"], ["Padma", "Latha", "F"], ["Mehreen", "Ali", "F"], ["Shirin", "Jahan", "F"],
  ["Mohammed", "Ilyas", "M"], ["Syed", "Afzal", "M"], ["Ravi", "Teja", "M"], ["Abdul", "Kareem", "M"],
  ["Srinivas", "Goud", "M"], ["Imran", "Hussain", "M"], ["Venkatesh", "Naidu", "M"], ["Faisal", "Ahmed", "M"],
  ["Mohammed", "Saleem", "M"], ["Arjun", "Reddy", "M"], ["Khaja", "Moinuddin", "M"], ["Rahul", "Sharma", "M"],
  ["Zaid", "Ilyas", "C"], ["Aaliya", "Afzal", "C"], ["Ishaan", "Teja", "C"], ["Maryam", "Hussain", "C"],
  ["Rehan", "Kareem", "C"], ["Anvi", "Goud", "C"],
];
const needs = { 7: "Uses a walking stick; needs the ground-floor room.", 16: "Hard of hearing; prefers written instructions." };
const patients = people.map(([firstName, lastName, kind], index) => ({
  index,
  id: stableId(`patient:${CLINIC}:${index}`),
  firstName,
  lastName,
  kind,
  phone: `+9190000${String(40000 + index).padStart(5, "0")}`,
  email: `${firstName}.${lastName}.${index}@example.com`.toLowerCase(),
  dateOfBirth: kind === "C"
    ? `${2014 + (index % 8)}-${String(1 + (index % 12)).padStart(2, "0")}-${String(3 + index % 20).padStart(2, "0")}`
    : `${1958 + ((index * 7) % 42)}-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + ((index * 3) % 27)).padStart(2, "0")}`,
  channel: pick(`channel:${index}`, ["whatsapp", "whatsapp", "whatsapp", "sms", "email"]),
  need: needs[index] ?? null,
}));
const women = patients.filter((patient) => patient.kind === "F");
const men = patients.filter((patient) => patient.kind === "M");
const children = patients.filter((patient) => patient.kind === "C");

// --- Dates (IST, fixed +05:30) -----------------------------------------------------------
const nowMs = Date.now();
const istNow = new Date(nowMs + IST_OFFSET_MINUTES * 60_000);
const todayUtcMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
const clinicInstant = (offset, minutes) =>
  new Date(todayUtcMidnight + offset * 86_400_000 + (minutes - IST_OFFSET_MINUTES) * 60_000);
const isoDay = (offset) => new Date(todayUtcMidnight + offset * 86_400_000).toISOString().slice(0, 10);

/** Each day every customer has exactly one visit, so nobody is double-booked. */
function patientsForDay(offset) {
  const rotate = (list, by) => list.map((_, i) => list[(i + by) % list.length]);
  const w = rotate(women, offset * 4);
  const m = rotate(men, offset * 5);
  const adults = rotate([...w.slice(6), ...m], offset * 7);
  return { 0: adults.slice(0, 10), 1: rotate(children, offset * 2), 2: w.slice(0, 6), 4: adults.slice(10, 18) };
}

function outcome(offset, key, startsAt, endsAt) {
  const r = rand(`status:${key}`);
  if (offset === 0) {
    if (endsAt.getTime() <= nowMs) {
      if (r < 0.08) return { status: "no_show", confirmation: "confirmed", form: "not_started" };
      if (r < 0.14) return { status: "cancelled", confirmation: "declined", form: "not_assigned" };
      return { status: "completed", confirmation: "confirmed", form: "submitted" };
    }
    if (startsAt.getTime() <= nowMs) return { status: "checked_in", confirmation: "confirmed", form: "submitted" };
    if (startsAt.getTime() - nowMs < 45 * 60_000 && r < 0.4) return { status: "checked_in", confirmation: "confirmed", form: "submitted" };
  }
  if (r < 0.05) return { status: "cancelled", confirmation: "declined", form: "not_assigned" };
  if (offset > 0 && r < 0.12) return { status: "requested", confirmation: "needs_action", form: "not_assigned" };
  const confirmed = rand(`confirm:${key}`) < (offset === 0 ? 0.9 : offset === 1 ? 0.7 : 0.45);
  return { status: "booked", confirmation: confirmed ? "confirmed" : "needs_action", form: pick(`form:${key}`, ["submitted", "in_progress", "not_started", "not_assigned"]) };
}

const notesPool = [
  "BP 150/95 last visit, recheck.", "Bring previous prescription.", "Fasting blood sugar report pending.",
  "Second dose due.", "Referred by Dr Khaleed.", "Prefers Urdu.", "Wants a morning slot next time.",
  null, null, null, null, null, null, null, null,
];

const appointments = [];
for (const offset of [0, 1, 2]) {
  const queue = patientsForDay(offset);
  for (const doctor of doctors) {
    const list = queue[doctor.index];
    // Half the list in the morning OPD (10:00–14:00), the rest in the evening OPD (17:00–21:00).
    const morning = Math.ceil(doctor.perDay / 2);
    const busy = doctor.perDay > 6;
    for (const [half, start, end, count] of [[0, 10 * 60, 14 * 60, morning], [1, 17 * 60, 21 * 60, doctor.perDay - morning]]) {
      let minute = start + 15 * Math.floor(rand(`start:${offset}:${doctor.index}:${half}`) * (busy ? 2 : 4));
      for (let n = 0; n < count; n += 1) {
        const position = half * morning + n;
        const key = `${offset}:${doctor.index}:${position}`;
        const service = serviceByKey[pick(`service:${key}`, doctor.services)];
        if (minute + service.duration > end) throw new Error(`Booking ${key} runs past the OPD session`);
        const startsAt = clinicInstant(offset, minute);
        const endsAt = clinicInstant(offset, minute + service.duration);
        const patient = list[position];
        const result = outcome(offset, key, startsAt, endsAt);
        appointments.push({
          id: stableId(`appointment:${CLINIC}:${key}`),
          patientId: patient.id,
          doctor,
          serviceId: serviceId(service.key),
          startsAt,
          endsAt,
          ...result,
          reminder: startsAt.getTime() < nowMs ? "delivered" : offset <= 1 && result.status !== "requested" ? "queued" : "not_scheduled",
          source: pick(`source:${key}`, ["online", "online", "phone", "phone", "walk_in", "staff", "widget"]),
          notes: pick(`notes:${key}`, notesPool),
          cancelledAt: result.status === "cancelled" ? new Date(Math.min(nowMs, startsAt.getTime()) - 3 * 3_600_000) : null,
        });
        minute += busy
          ? 15 * Math.ceil((service.duration + 5) / 15)
          : service.duration + 15 + 15 * Math.floor(rand(`gap:${key}`) * 3);
      }
    }
  }
}
if (appointments.length !== 90) throw new Error(`Expected 90 bookings, built ${appointments.length}`);

// --- Owner sign-in ---------------------------------------------------------------------
const saved = existsSync(credentialsPath) ? JSON.parse(readFileSync(credentialsPath, "utf8")) : {};
const credentials = { ...saved, email: owner.email, password: saved.password ?? randomBytes(15).toString("base64url") };
const ownerUserId = stableId(`staff:${owner.email}`);

// --- Write -----------------------------------------------------------------------------
const sql = postgres(databaseUrl, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`
      INSERT INTO tenants (id, slug, name, legal_name, phone, email, timezone, locale, business_type, about, currency, week_start)
      VALUES (${tenantId}, ${clinic.slug}, ${clinic.name}, ${clinic.legalName}, ${clinic.phone}, ${clinic.email},
        'Asia/Kolkata', 'en-IN', 'healthcare', ${clinic.about}, 'INR', 1)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, about = EXCLUDED.about
    `;
    await tx`
      INSERT INTO locations (id, tenant_id, name, address, city, timezone, accessible_entrance)
      VALUES (${locationId}, ${tenantId}, ${clinic.locationName}, ${clinic.address}, ${clinic.city}, 'Asia/Kolkata', true)
      ON CONFLICT (id) DO UPDATE SET address = EXCLUDED.address
    `;

    await tx`
      INSERT INTO auth_users (id, name, email, email_verified, password_set_at)
      VALUES (${ownerUserId}, ${owner.name}, ${owner.email}, true, now())
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO auth_accounts (id, issuer, account_id, provider_id, user_id, password)
      VALUES (${stableId(`account:${owner.email}`)}, 'local:credential', ${ownerUserId}, 'credential', ${ownerUserId},
        ${await hashPassword(credentials.password)})
      ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password
    `;
    await tx`
      INSERT INTO memberships (id, tenant_id, user_id, role)
      VALUES (${stableId(`membership:${CLINIC}:${owner.email}`)}, ${tenantId}, ${ownerUserId}, 'owner')
      ON CONFLICT (id) DO NOTHING
    `;

    for (const [order, service] of services.entries()) {
      const id = serviceId(service.key);
      await tx`
        INSERT INTO services (id, tenant_id, name, description, duration_minutes, slot_interval_minutes,
          minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, required_resource_kind,
          category, price_minor, slug)
        VALUES (${id}, ${tenantId}, ${service.name}, ${service.description}, ${service.duration}, 15,
          60, 60, 'instant', ${["new", "returning"]}, 'room', ${service.category}, ${service.price}, ${service.key})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
          duration_minutes = EXCLUDED.duration_minutes, category = EXCLUDED.category, price_minor = EXCLUDED.price_minor, is_active = true
      `;
      await tx`INSERT INTO service_locations (tenant_id, service_id, location_id) VALUES (${tenantId}, ${id}, ${locationId}) ON CONFLICT DO NOTHING`;
      await tx`
        INSERT INTO service_durations (id, tenant_id, service_id, minutes, is_default, sort_order)
        VALUES (${stableId(`duration:${CLINIC}:${service.key}`)}, ${tenantId}, ${id}, ${service.duration}, true, 0)
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO service_location_options (id, tenant_id, service_id, kind, location_id, sort_order)
        VALUES (${stableId(`location-option:${CLINIC}:${service.key}`)}, ${tenantId}, ${id}, 'in_person', ${locationId}, 0)
        ON CONFLICT (id) DO NOTHING
      `;
      void order;
    }

    for (const doctor of doctors) {
      const id = doctorId(doctor);
      await tx`
        INSERT INTO resources (id, tenant_id, location_id, name, kind)
        VALUES (${roomId(doctor)}, ${tenantId}, ${locationId}, ${doctor.room}, 'room')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      `;
      await tx`
        INSERT INTO practitioners (id, tenant_id, name, title, initials, specialty, languages, experience_years, qualifications)
        VALUES (${id}, ${tenantId}, ${doctor.name}, ${doctor.title}, ${doctor.initials}, ${doctor.specialty},
          ${doctor.languages}, ${doctor.years}, ${doctor.qualifications})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title, initials = EXCLUDED.initials,
          specialty = EXCLUDED.specialty, languages = EXCLUDED.languages, experience_years = EXCLUDED.experience_years,
          qualifications = EXCLUDED.qualifications
      `;
      await tx`
        DELETE FROM practitioner_services
        WHERE tenant_id = ${tenantId} AND practitioner_id = ${id}
          AND NOT (service_id = ANY(${[...new Set(doctor.services)].map(serviceId)}))
      `;
      await tx`INSERT INTO practitioner_locations (tenant_id, practitioner_id, location_id) VALUES (${tenantId}, ${id}, ${locationId}) ON CONFLICT DO NOTHING`;
      for (const key of new Set(doctor.services)) {
        await tx`INSERT INTO practitioner_services (tenant_id, practitioner_id, service_id) VALUES (${tenantId}, ${id}, ${serviceId(key)}) ON CONFLICT DO NOTHING`;
      }
      const scheduleId = stableId(`schedule:${CLINIC}:${doctor.index}`);
      await tx`
        INSERT INTO availability_schedules (id, tenant_id, practitioner_id, name, timezone, is_default)
        VALUES (${scheduleId}, ${tenantId}, ${id}, 'OPD hours', 'Asia/Kolkata', true)
        ON CONFLICT (id) DO NOTHING
      `;
      for (const day of [1, 2, 3, 4, 5, 6]) {
        for (const [session, [from, to]] of sessions.entries()) {
          await tx`
            INSERT INTO availability_rules (id, tenant_id, schedule_id, location_id, practitioner_id, day_of_week,
              starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            VALUES (${stableId(`availability:${CLINIC}:${doctor.index}:${day}:${session}`)}, ${tenantId}, ${scheduleId},
              ${locationId}, ${id}, ${day}, ${from}, ${to}, 'Asia/Kolkata', '2025-01-01', 15)
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }
    }

    for (const patient of patients) {
      await tx`
        INSERT INTO patients (id, tenant_id, first_name, last_name, phone, email, date_of_birth, preferred_channel, accessibility_need)
        VALUES (${patient.id}, ${tenantId}, ${patient.firstName}, ${patient.lastName}, ${patient.phone}, ${patient.email},
          ${patient.dateOfBirth}, ${patient.channel}, ${patient.need})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Remove the retired practitioner slots, with their untouched bookings and their rooms.
    for (const index of retiredDoctorIndexes) {
      const id = doctorId({ index });
      await tx`
        DELETE FROM appointments AS appointment
        WHERE appointment.tenant_id = ${tenantId} AND appointment.practitioner_id = ${id}
          AND NOT EXISTS (SELECT 1 FROM audit_events WHERE audit_events.appointment_id = appointment.id)
          AND NOT EXISTS (SELECT 1 FROM visit_records WHERE visit_records.appointment_id = appointment.id)
      `;
      const [{ left }] = await tx`SELECT count(*)::int AS left FROM appointments WHERE tenant_id = ${tenantId} AND practitioner_id = ${id}`;
      if (left > 0) {
        await tx`UPDATE practitioners SET is_active = false WHERE tenant_id = ${tenantId} AND id = ${id}`;
      } else {
        await tx`DELETE FROM resource_reservations WHERE tenant_id = ${tenantId} AND (practitioner_id = ${id} OR resource_id = ${roomId({ index })})`;
        await tx`DELETE FROM practitioners WHERE tenant_id = ${tenantId} AND id = ${id}`;
        await tx`DELETE FROM resources WHERE tenant_id = ${tenantId} AND id = ${roomId({ index })}`;
      }
    }

    // Replace this seed's earlier bookings that nobody has acted on yet.
    const removed = await tx`
      DELETE FROM appointments AS appointment
      WHERE appointment.tenant_id = ${tenantId}
        AND appointment.id = ANY(${appointments.map((appointment) => appointment.id)})
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE audit_events.appointment_id = appointment.id)
        AND NOT EXISTS (SELECT 1 FROM visit_records WHERE visit_records.appointment_id = appointment.id)
        AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.appointment_id = appointment.id)
      RETURNING appointment.id
    `;
    const kept = new Set((await tx`
      SELECT id FROM appointments WHERE tenant_id = ${tenantId} AND id = ANY(${appointments.map((appointment) => appointment.id)})
    `).map((row) => row.id));

    const priceOf = new Map(services.map((service) => [serviceId(service.key), service.price]));
    let paid = 0;
    for (const appointment of appointments) {
      if (kept.has(appointment.id)) continue;
      await tx`
        INSERT INTO appointments (id, tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at,
          status, confirmation_status, booking_source, form_status, reminder_status, manage_token_hash, notes, cancelled_at)
        VALUES (${appointment.id}, ${tenantId}, ${locationId}, ${appointment.patientId}, ${doctorId(appointment.doctor)},
          ${appointment.serviceId}, ${appointment.startsAt}, ${appointment.endsAt}, ${appointment.status},
          ${appointment.confirmation}, ${appointment.source}, ${appointment.form}, ${appointment.reminder},
          ${createHash("sha256").update(`demo-manage:${appointment.id}`).digest("hex")}, ${appointment.notes}, ${appointment.cancelledAt})
      `;
      const state = appointment.status === "cancelled" ? "released" : appointment.status === "requested" ? "held" : "confirmed";
      for (const [subject, practitionerId, resourceId] of [
        ["practitioner", doctorId(appointment.doctor), null],
        ["resource", null, roomId(appointment.doctor)],
      ]) {
        await tx`
          INSERT INTO resource_reservations (id, tenant_id, appointment_id, practitioner_id, resource_id, starts_at, ends_at, state)
          VALUES (${stableId(`reservation:${appointment.id}:${subject}`)}, ${tenantId}, ${appointment.id},
            ${practitionerId}, ${resourceId}, ${appointment.startsAt}, ${appointment.endsAt}, ${state})
        `;
      }
      // Most finished visits were paid at the desk; a few are left for the front desk to collect.
      // Payments can never be changed or deleted, so a booking with one is kept on the next run.
      if (appointment.status === "completed" && rand(`unpaid:${appointment.id}`) >= 0.15) {
        await tx`
          INSERT INTO payments (id, tenant_id, appointment_id, amount_minor, currency, method, recorded_by_user_id, created_at)
          VALUES (${stableId(`payment:${appointment.id}`)}, ${tenantId}, ${appointment.id}, ${priceOf.get(appointment.serviceId)},
            'INR', ${pick(`method:${appointment.id}`, ["cash", "cash", "upi", "upi", "upi", "card"])}, ${ownerUserId},
            ${new Date(appointment.endsAt.getTime() + 5 * 60_000)})
          ON CONFLICT DO NOTHING
        `;
        paid += 1;
      }
    }

    // Everyone who arrived today has a token, as the app's check-in gives one (issueQueueTicket in src/server/queue.ts).
    // Finished visits were called at their start time; checked-in ones wait for Call next.
    const arrived = appointments
      .filter((appointment) => appointment.startsAt >= clinicInstant(0, 0) && appointment.startsAt < clinicInstant(1, 0))
      .sort((a, b) => a.startsAt - b.startsAt);
    let tokens = 0;
    // This seed's bookings get fresh tokens in start-time order each run; tokens for anyone else (walk-ins
    // added in the app) stay, and the counter carries on from the highest of those.
    await tx`DELETE FROM queue_tickets WHERE tenant_id = ${tenantId} AND appointment_id = ANY(${appointments.map((appointment) => appointment.id)})`;
    await tx`
      UPDATE queue_counters SET last_number = (
        SELECT coalesce(max(number), 0) FROM queue_tickets
        WHERE tenant_id = ${tenantId} AND location_id = ${locationId} AND day = ${isoDay(0)}::date)
      WHERE tenant_id = ${tenantId} AND location_id = ${locationId} AND day = ${isoDay(0)}::date
    `;
    for (const appointment of arrived) {
      const [{ status }] = await tx`SELECT status FROM appointments WHERE tenant_id = ${tenantId} AND id = ${appointment.id}`;
      if (status !== "checked_in" && status !== "completed") continue;
      const [{ day, number }] = await tx`
        INSERT INTO queue_counters (tenant_id, location_id, day, last_number)
        VALUES (${tenantId}, ${locationId}, ${isoDay(0)}, 1)
        ON CONFLICT (tenant_id, location_id, day) DO UPDATE SET last_number = queue_counters.last_number + 1
        RETURNING day::text AS day, last_number AS number
      `;
      await tx`
        INSERT INTO queue_tickets (tenant_id, location_id, day, number, appointment_id, called_at, call_count, created_at)
        VALUES (${tenantId}, ${locationId}, ${day}, ${number}, ${appointment.id},
          ${status === "completed" ? appointment.startsAt : null}, ${status === "completed" ? 1 : 0},
          ${new Date(appointment.startsAt.getTime() - 10 * 60_000)})
      `;
      tokens += 1;
    }

    // Retire services the research did not support: delete when no booking uses them, else hide.
    for (const key of retiredServiceKeys) {
      const id = serviceId(key);
      await tx`DELETE FROM practitioner_services WHERE tenant_id = ${tenantId} AND service_id = ${id}`;
      const [{ used }] = await tx`SELECT count(*)::int AS used FROM appointments WHERE tenant_id = ${tenantId} AND service_id = ${id}`;
      if (used > 0) await tx`UPDATE services SET is_active = false WHERE tenant_id = ${tenantId} AND id = ${id}`;
      else await tx`DELETE FROM services WHERE tenant_id = ${tenantId} AND id = ${id}`;
    }

    const byStatus = {};
    for (const appointment of appointments) byStatus[appointment.status] = (byStatus[appointment.status] ?? 0) + 1;
    console.log(`B-One Clinic, Tolichowki (today is ${isoDay(0)} IST)`);
    console.log(`  ${doctors.length} practitioners, ${services.length} services, ${doctors.length} rooms, ${patients.length} customers`);
    console.log(`  90 bookings: ${[0, 1, 2].map((o) => `${isoDay(o)} 30`).join(", ")}; ${JSON.stringify(byStatus)}`);
    console.log(`  ${removed.length} earlier bookings replaced, ${kept.size} kept, ${paid} finished visits paid, ${tokens} queue tokens issued`);
  });
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  console.log(`  owner sign-in saved to .local-db/b-one-clinic-owner.json`);
} finally {
  await sql.end();
}
