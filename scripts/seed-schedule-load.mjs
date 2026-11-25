// Fills a throwaway database with appointments for checking the staff schedule by hand or in a load test.
// Never run it against a database that holds real data: it adds fake customers and visits.
//
//   KALENDR_LOAD_DATABASE_URL=<owner url on this machine> node scripts/seed-schedule-load.mjs \
//     --clinic lotus-dental --date 2026-11-16 --mode diary
//   ... --date 2026-11-17 --mode load --count 300
//
// diary: a believable day. Each staff member books every half hour from 09:00 with a few gaps; every visit
//        holds the staff member and their own chair, so a drag onto a taken time is a real clash.
// load:  N visits on one day spread over the working day and stacked on top of each other, with no
//        reservations. It exists to see how the screen copes with a very long day, not to be realistic.
import { randomUUID } from "node:crypto";

import postgres from "postgres";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const url = process.env.KALENDR_LOAD_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Set KALENDR_LOAD_DATABASE_URL to the owner URL of a throwaway database on this machine.");
}
const slug = args.clinic ?? "lotus-dental";
const date = args.date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Pass --date YYYY-MM-DD.");
const mode = args.mode ?? "diary";
const count = Number(args.count ?? 300);

const firstNames = ["Asha", "Ravi", "Meera", "Imran", "Priya", "Kabir", "Nisha", "Arjun", "Sana", "Vikram", "Tara", "Dev", "Isha", "Rahul", "Anaya", "Zoya", "Karan", "Leela", "Omar", "Divya"];
const lastNames = ["Rao", "Shah", "Iyer", "Khan", "Nair", "Mehta", "Ali", "Patel", "Singh", "Desai", "Joshi", "Menon"];

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [tenant] = await sql`select id from tenants where slug = ${slug}`;
  if (!tenant) throw new Error(`No business with the address ${slug}.`);
  const [location] = await sql`select id from locations where tenant_id = ${tenant.id} order by id limit 1`;
  const staff = await sql`select id, name from practitioners where tenant_id = ${tenant.id} order by name`;
  const [service] = await sql`select id, duration_minutes from services where tenant_id = ${tenant.id} order by duration_minutes limit 1`;
  const chairs = await sql`select id from resources where tenant_id = ${tenant.id} order by name`;

  const people = [];
  for (let index = 0; index < 60; index += 1) {
    const [patient] = await sql`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant.id}, ${firstNames[index % firstNames.length]}, ${`${lastNames[index % lastNames.length]} ${Math.floor(index / firstNames.length) + 1}`},
        ${`+91 98${String(70000000 + index * 7919).slice(0, 3)} ${String(10000 + index * 37).slice(0, 5)}`}, ${`load.${index}.${randomUUID().slice(0, 6)}@example.com`}, 'sms')
      returning id`;
    people.push(patient.id);
  }

  // 09:00 India time is 03:30 UTC. The schedule shows the business's own clock, so every time is built from that.
  const at = (minutes) => new Date(Date.parse(`${date}T00:00:00+05:30`) + minutes * 60_000);
  let created = 0;
  async function add(practitionerId, chairId, start, minutes, reserve) {
    const [row] = await sql`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${tenant.id}, ${location.id}, ${people[created % people.length]}, ${practitionerId}, ${service.id}, ${at(start)}, ${at(start + minutes)}, 'booked', 'phone', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})
      returning id`;
    if (reserve) {
      await sql`insert into resource_reservations (tenant_id, appointment_id, practitioner_id, starts_at, ends_at, state) values (${tenant.id}, ${row.id}, ${practitionerId}, ${at(start)}, ${at(start + minutes)}, 'confirmed')`;
      if (chairId) await sql`insert into resource_reservations (tenant_id, appointment_id, resource_id, starts_at, ends_at, state) values (${tenant.id}, ${row.id}, ${chairId}, ${at(start)}, ${at(start + minutes)}, 'confirmed')`;
    }
    created += 1;
  }

  if (mode === "diary") {
    for (const [index, person] of staff.entries()) {
      for (let slot = 0; slot < 16; slot += 1) {
        // Leave gaps in a repeating pattern so there is somewhere to drop a card.
        if ((slot + index * 2) % 5 === 3) continue;
        await add(person.id, chairs[index % chairs.length]?.id, 9 * 60 + slot * 30, service.duration_minutes, true);
      }
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      const person = staff[index % staff.length];
      await add(person.id, null, 8 * 60 + (index * 37) % (10 * 60), service.duration_minutes, false);
    }
  }
  console.log(`Added ${created} visits on ${date} for ${slug} (${mode}).`);
} finally {
  await sql.end();
}
