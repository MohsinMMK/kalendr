import "server-only";

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, magicLink, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { sendEmailChangeConfirmation, sendMagicLinkEmail, sendPasswordResetEmail, sendVerificationEmail } from "@/server/auth-email";
import { ApiError } from "@/server/api-error";
import { devOAuthEnabled } from "@/server/dev-oauth";
import { companySignIn } from "@/server/enterprise/sso-plugin";
import { companySignInRequiredFor, mustRefuseNewSession } from "@/server/enterprise/sso-guard";
import { env } from "@/server/env";
import {
  afterOwnEmailConfirmed,
  afterOwnEmailRequested,
  assertOwnEmailChangeAllowed,
  beforeOwnEmailConfirmed,
  readEmailChangeToken,
  type PendingEmailChange,
} from "@/server/staff-email-change";
import {
  dropPlaceholderPassword,
  recordSignInTime,
  hasActiveMembership,
  markSecondFactor,
  noteDeviceSignIn,
  noticeSecurityChange,
  recordAuthEvent,
  signOutOtherDevices,
} from "@/server/staff-security";

import { getDatabase } from "@/db/client";
import {
  authAccounts,
  authPasskeys,
  authSessions,
  authTwoFactors,
  authUsers,
  authVerifications,
} from "@/db/schema";

const database = getDatabase();
const settings = env();
const configuredSecret = settings.BETTER_AUTH_SECRET;

// The placeholder only allows the module to build in database-free preview
// environments. API handlers fail closed unless authIsConfigured is true.
const authSecret =
  configuredSecret ?? "kalendr-preview-auth-disabled-000000000000000000000000";

export const authIsConfigured = Boolean(database && configuredSecret);
const authBaseUrl =
  settings.BETTER_AUTH_URL ??
  settings.NEXT_PUBLIC_APP_URL ??
  (authIsConfigured ? undefined : "http://localhost:3000");

export const auth = betterAuth({
  ...(database
    ? {
        database: drizzleAdapter(database, {
          provider: "pg",
          schema: {
            user: authUsers,
            session: authSessions,
            account: authAccounts,
            verification: authVerifications,
            twoFactor: authTwoFactors,
            passkey: authPasskeys,
          },
        }),
      }
    : {}),
  baseURL: authBaseUrl,
  secret: authSecret,
  trustedOrigins: getTrustedOrigins(),
  emailAndPassword: {
    enabled: true,
    disableSignUp: settings.BETTER_AUTH_ALLOW_SIGNUP !== "true",
    requireEmailVerification:
      settings.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION !== "false",
    minPasswordLength: 12,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ email: user.email, name: user.name, url });
    },
    // An invited person has no password of their own until they use their link.
    onPasswordReset: async ({ user }) => {
      if (!database) return;
      await database.update(authUsers).set({ passwordSetAt: new Date(), emailVerified: true }).where(eq(authUsers.id, user.id));
    },
  },
  // Reset, invite and verification tokens are stored as SHA-256 hashes, so a copy of the
  // database can't be used to open someone's account. The raw token exists only in the link.
  verification: {
    storeIdentifier: "hashed",
  },
  emailVerification: {
    sendOnSignIn: true,
    // A link from a change-email request goes to the NEW address (Better Auth puts it in `user.email` here) with its own wording.
    sendVerificationEmail: async ({ user, url, token }) => {
      if (readEmailChangeToken(token)) await sendEmailChangeConfirmation({ email: user.email, name: user.name, url });
      else await sendVerificationEmail(user.email, url);
    },
  },
  // A person changes their own sign-in email: a one-hour link goes to the new address, and the email moves only when it is opened.
  // `sendChangeEmailConfirmation` is left off on purpose (it would mail an approval link to the OLD address, which an intruder
  // with the mailbox could click) and so is `updateEmailWithoutVerification`. The old address gets a heads-up instead, from the
  // hooks below. The email stays verified, because opening the link proves the new address.
  user: { changeEmail: { enabled: true } },
  // Google and Microsoft only ever link to a person who already exists (an invite creates them).
  // They are not "trusted providers", so the provider must say the email is verified, and an
  // invited person's own email is not yet verified, which is why the local check is off.
  account: {
    accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: false },
  },
  socialProviders: socialProviders(),
  session: {
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 60,
    additionalFields: {
      secondFactorAt: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Staff are invited, never self-registered: owners are created by /start and teammates by an
        // invite, both with direct inserts. A user Better Auth would create itself (a stranger
        // arriving through Google, a magic link) is refused here as a second line behind the
        // providers' own sign-up switches.
        before: async () => {
          if (settings.BETTER_AUTH_ALLOW_SIGNUP === "true") return;
          throw new APIError("FORBIDDEN", { message: "Ask your manager to invite you.", code: "SIGN_UP_DISABLED" });
        },
      },
    },
    session: {
      create: {
        // No membership, no session, however the person proved who they are.
        before: async (session, context) => {
          if (!(await hasActiveMembership(session.userId))) {
            throw new APIError("FORBIDDEN", { message: "Ask your manager to invite you.", code: "NO_ACTIVE_MEMBERSHIP" });
          }
          // A business can require company sign-in for its domain (feature 53). Only that sign-in, and the break-glass owner, make a session.
          const required = await companySignInRequiredFor(session.userId);
          if (mustRefuseNewSession({ path: context?.path ?? "", heldSessionUserId: required ? await heldSessionUserId(context) : null, userId: session.userId, companySignInRequired: required })) {
            await recordAuthEvent(session.userId, "staff.sign_in.refused", "denied", { reason: "company_sign_in_required" });
            throw new APIError("FORBIDDEN", { message: "Your company needs you to sign in with company sign-in.", code: "SSO_REQUIRED" });
          }
        },
        after: async (session, context) => {
          const path = context?.path ?? "";
          await recordSignInTime(session.userId, path).catch(() => undefined);
          // Company sign-in records its own event once the session is set.
          if (path.startsWith("/sso/")) return;
          const user = await database?.select({ id: authUsers.id, email: authUsers.email, name: authUsers.name, twoFactorEnabled: authUsers.twoFactorEnabled }).from(authUsers).where(eq(authUsers.id, session.userId)).limit(1);
          const person = user?.[0];
          if (!person) return;
          // A password sign-in with a second factor creates a session that is deleted at once and
          // replaced after the code is checked. Only the real one counts as a sign-in.
          if (person.twoFactorEnabled && path === "/sign-in/email") return;
          await recordAuthEvent(person.id, "staff.sign_in", "success", { method: signInMethod(path) });
          await noteDeviceSignIn(person, session.userAgent ?? null);
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path === "/two-factor/verify-totp") {
        const current = await auth.api.getSession({ headers: context.headers ?? new Headers() }).catch(() => null);
        if (current) wasEnrolled.set(context.context, current.user.twoFactorEnabled === true);
      }
      // Changing your own email: a fresh second factor and a free address, whichever door the request used.
      if (context.path === "/change-email") {
        const current = await auth.api.getSession({ headers: context.headers ?? new Headers() }).catch(() => null);
        if (!current) return;
        const newEmail = typeof context.body?.newEmail === "string" ? context.body.newEmail : "";
        await asAuthError(() => assertOwnEmailChangeAllowed({ userId: current.user.id, secondFactorAt: current.session.secondFactorAt ?? null }, newEmail));
      }
      // Opening the link: note who and what, so the after hook can tell a real change from a failed or repeated link.
      if (context.path === "/verify-email") {
        const token = typeof context.query?.token === "string" ? context.query.token : undefined;
        const pending = await beforeOwnEmailConfirmed(token);
        if (pending) {
          const current = await auth.api.getSession({ headers: context.headers ?? new Headers() }).catch(() => null);
          pendingEmailChange.set(context.context, { ...pending, sessionToken: current?.user.id === pending.change.userId ? current.session.token : null });
        }
      }
    }),
    after: createAuthMiddleware(async (context) => {
      const failed = context.context.returned instanceof Error;
      const live = context.context.newSession ?? context.context.session;
      const userId = live?.user.id;
      switch (context.path?.startsWith("/callback/") ? "/callback/:id" : context.path) {
        case "/sign-in/email": {
          if (!failed) return;
          const email = typeof context.body?.email === "string" ? context.body.email.trim().toLowerCase() : null;
          const known = email && database ? (await database.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1))[0] : null;
          if (known) await recordAuthEvent(known.id, "staff.sign_in.failed", "failed", { method: "password" });
          return;
        }
        case "/two-factor/verify-totp":
        case "/two-factor/verify-backup-code":
        case "/passkey/verify-authentication": {
          if (failed) {
            if (userId) await recordAuthEvent(userId, "staff.second_factor.failed", "failed", { method: signInMethod(context.path) });
            return;
          }
          if (!live) return;
          await markSecondFactor(live.session.token);
          const enrolling = context.path === "/two-factor/verify-totp" && wasEnrolled.get(context.context) === false;
          if (enrolling) {
            await recordAuthEvent(live.user.id, "staff.second_factor.enabled", "success");
            await noticeSecurityChange(live.user, "An authenticator app was added to your account");
          } else {
            await recordAuthEvent(live.user.id, "staff.second_factor.verified", "success", { method: signInMethod(context.path) });
          }
          return;
        }
        case "/two-factor/disable": {
          if (failed || !live) return;
          await recordAuthEvent(live.user.id, "staff.second_factor.disabled", "success");
          await signOutOtherDevices(live.user.id, live.session.token);
          await noticeSecurityChange(live.user, "The authenticator app on your account was removed");
          return;
        }
        case "/two-factor/generate-backup-codes": {
          if (failed || !live) return;
          await recordAuthEvent(live.user.id, "staff.second_factor.backup_codes_regenerated", "success");
          await noticeSecurityChange(live.user, "Your backup codes were replaced");
          return;
        }
        case "/passkey/verify-registration": {
          if (failed || !live) return;
          await recordAuthEvent(live.user.id, "staff.passkey.added", "success");
          await noticeSecurityChange(live.user, "A passkey was added to your account");
          return;
        }
        case "/passkey/delete-passkey": {
          if (failed || !live) return;
          await recordAuthEvent(live.user.id, "staff.passkey.removed", "success");
          await noticeSecurityChange(live.user, "A passkey was removed from your account");
          return;
        }
        case "/change-email": {
          if (failed || !live) return;
          await afterOwnEmailRequested(live.user);
          return;
        }
        case "/verify-email": {
          // A good link ends in a redirect, which Better Auth throws, so the database says whether it worked.
          const pending = pendingEmailChange.get(context.context);
          if (pending) await afterOwnEmailConfirmed(pending, pending.sessionToken);
          return;
        }
        case "/revoke-session":
        case "/revoke-other-sessions":
        case "/revoke-sessions": {
          if (failed || !live) return;
          await recordAuthEvent(live.user.id, context.path === "/revoke-session" ? "staff.device.removed" : "staff.devices.removed_all", "success");
          return;
        }
        case "/change-password": {
          if (failed || !live) return;
          // A new password ends every other sign-in, whatever the screen asked for.
          await signOutOtherDevices(live.user.id, live.session.token);
          await noticeSecurityChange(live.user, "Your password was changed");
          return;
        }
        case "/magic-link/verify":
        case "/callback/:id": {
          // These end in a redirect, which Better Auth throws, so "failed" can't be read from the
          // return value. A new session is the sign of success.
          if (!context.context.newSession || !userId) return;
          // The first time an invited person signs in this way, the placeholder password that came with the invite goes.
          await dropPlaceholderPassword(userId);
          return;
        }
        default:
          return;
      }
    }),
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    // Each request sends mail to a stranger's address, so it is held to a few an hour.
    customRules: { "/change-email": { window: 60 * 60, max: 5 } },
  },
  advanced: {
    cookiePrefix: "kalendr",
    useSecureCookies: settings.NODE_ENV === "production",
  },
  plugins: [
    nextCookies(),
    companySignIn(),
    twoFactor({
      issuer: "Kalendr",
      // Invited people have no password they know; the plugin still asks for one if a real one exists.
      allowPasswordless: true,
      totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
      twoFactorCookieMaxAge: 10 * 60,
    }),
    passkey({
      rpName: "Kalendr",
      // A phone's fingerprint, face or PIN must be checked: that check is what makes a passkey two factors.
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    }),
    magicLink({
      expiresIn: 10 * 60,
      disableSignUp: true,
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        // A stranger's address gets no email, and the screen answers the same either way.
        const [user] = database ? await database.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email.trim().toLowerCase())).limit(1) : [];
        if (!user || !(await hasActiveMembership(user.id))) return;
        await sendMagicLinkEmail({ email, url });
      },
    }),
    ...(devOAuthEnabled() ? [genericOAuth({ config: devOAuthProviders() })] : []),
  ],
});

/** Whether each outside sign-in is switched on, for the sign-in screen. The dev stand-in counts as on in development. */
export function enabledSocialProviders(): { google: boolean; microsoft: boolean; stand_in: boolean } {
  const standIn = devOAuthEnabled();
  return {
    google: standIn || Boolean(settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET),
    microsoft: standIn || Boolean(settings.MICROSOFT_CLIENT_ID && settings.MICROSOFT_CLIENT_SECRET),
    stand_in: standIn,
  };
}

const wasEnrolled = new WeakMap<object, boolean>();
const pendingEmailChange = new WeakMap<object, PendingEmailChange & { sessionToken: string | null }>();

/** The email-change rules throw our own `ApiError`; Better Auth's hooks need its `APIError`, with the same code and words. */
async function asAuthError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    if (!(error instanceof ApiError)) throw error;
    const status = error.status === 403 ? "FORBIDDEN" : error.status === 409 ? "CONFLICT" : error.status === 503 ? "SERVICE_UNAVAILABLE" : "BAD_REQUEST";
    throw new APIError(status, { message: error.message, code: error.code });
  }
}

/** The person whose live session this request already carries, if any (feature 53): used so enrolling a second factor can't lock them out. */
async function heldSessionUserId(context: { headers?: Headers; context?: unknown } | null | undefined): Promise<string | null> {
  const direct = (context?.context as { session?: { user?: { id?: string } } | null } | undefined)?.session?.user?.id;
  if (direct) return direct;
  if (!context?.headers) return null;
  const current = await auth.api.getSession({ headers: context.headers }).catch(() => null);
  return current?.user.id ?? null;
}

function signInMethod(path: string): string {
  if (path.includes("passkey")) return "passkey";
  if (path.includes("magic-link")) return "magic_link";
  if (path.includes("/sso/")) return "company_sign_in";
  if (path.includes("callback") || path.includes("oauth")) return "oauth";
  if (path.includes("two-factor")) return "second_factor";
  return "password";
}

/** The real providers. Neither one may create a person: only an invited, active teammate gets in. */
function socialProviders() {
  if (devOAuthEnabled()) return {};
  return {
    ...(settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET, disableImplicitSignUp: true, prompt: "select_account" as const } }
      : {}),
    ...(settings.MICROSOFT_CLIENT_ID && settings.MICROSOFT_CLIENT_SECRET
      ? { microsoft: { clientId: settings.MICROSOFT_CLIENT_ID, clientSecret: settings.MICROSOFT_CLIENT_SECRET, tenantId: settings.MICROSOFT_TENANT_ID ?? "common", disableImplicitSignUp: true, prompt: "select_account" as const } }
      : {}),
  };
}

/** Development stand-ins registered under the real providers' ids, so the sign-in screen and callbacks are identical. */
function devOAuthProviders() {
  const base = (authBaseUrl ?? "http://localhost:3000").replace(/\/$/, "");
  return (["google", "microsoft"] as const).map((providerId) => ({
    providerId,
    clientId: "dev-stand-in",
    clientSecret: "dev-stand-in",
    authorizationUrl: `${base}/api/dev-oauth/authorize`,
    tokenUrl: `${base}/api/dev-oauth/token`,
    userInfoUrl: `${base}/api/dev-oauth/userinfo`,
    scopes: ["openid", "email", "profile"],
    pkce: false,
    disableImplicitSignUp: true,
  }));
}

function getTrustedOrigins(): string[] {
  const candidates = [
    settings.BETTER_AUTH_URL,
    settings.NEXT_PUBLIC_APP_URL,
    ...(settings.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
  ];

  return candidates.flatMap((candidate) => {
    if (!candidate) return [];
    try {
      const origin = new URL(candidate.trim()).origin;
      if (origin.startsWith("https://")) return [origin];
      if (
        settings.NODE_ENV !== "production" &&
        (origin.startsWith("http://localhost:") ||
          origin.startsWith("http://127.0.0.1:"))
      ) {
        return [origin];
      }
    } catch {
      return [];
    }
    return [];
  });
}
