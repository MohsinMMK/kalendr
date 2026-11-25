// Makes an existing user a platform operator (feature 15), as the super role, so they can open /admin.
//
//   KALENDR_SEED_DATABASE_URL=<owner connection> node scripts/make-platform-admin.mjs person@example.com [support|billing|super]
//
// The person must already have an account (a staff sign-in). They also need a second factor (authenticator app or
// passkey) before the console lets them in. This is the only way to create the first operator; after that a super
// operator manages the list from the console. Uses the schema owner's connection because the runtime role cannot
// write platform_admins. Prints no address and no connection string.
import postgres from "postgres";

const [email, roleArgument = "super"] = process.argv.slice(2);
const url = process.env.KALENDR_SEED_DATABASE_URL;

if (!url || !email || !/^[^@\s]+@[^@\s]+$/.test(email) || !["support", "billing", "super"].includes(roleArgument)) {
  console.error("Usage: KALENDR_SEED_DATABASE_URL=<owner url> node scripts/make-platform-admin.mjs <email> [support|billing|super]");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [user] = await sql`select id from auth_users where lower(email) = lower(${email})`;
  if (!user) {
    console.error("No account has that email. They must sign in once (an invite creates the account) before they can be made an operator.");
    process.exitCode = 1;
  } else {
    await sql`
      insert into platform_admins (user_id, role, is_active) values (${user.id}, ${roleArgument}, true)
      on conflict (user_id) do update set role = excluded.role, is_active = true
    `;
    await sql`
      insert into platform_audit_events (admin_user_id, action, reason, metadata)
      values (${user.id}, 'admin.operator.created_from_cli', 'Made an operator from the command line', ${sql.json({ role: roleArgument })})
    `;
    console.log(`Done. The user is now a ${roleArgument} operator. They must have a second factor set up to open /admin.`);
  }
} finally {
  await sql.end();
}
