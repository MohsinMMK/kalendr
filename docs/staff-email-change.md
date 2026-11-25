# Changing a staff sign-in email

Two ways, one rule for "is this address free" (`assertEmailAvailable` in `src/server/staff-credentials.ts`, also used by invites and practitioner logins).

## A person changes their own (My profile → Change email)

- Better Auth `user.changeEmail: { enabled: true }` in `src/lib/auth.ts`. `sendChangeEmailConfirmation` and `updateEmailWithoutVerification` are **off** on purpose: the first would mail an approval link to the *old* address, the second changes an unverified person's email with no proof.
- With those off, Better Auth sends a one-hour link (a signed JWT, `change-email-verification`) to the **new** address through `emailVerification.sendVerificationEmail`. The email moves only when the link is opened, and `emailVerified` stays as it was (true), because opening the link proves the address.
- The link goes out inside the request, like invite and reset links (it holds a live token, so it must not sit in the outbox table). Without an email provider, development prints it; production answers 503 `email_unavailable`.
- Hooks in `src/lib/auth.ts` (logic in `src/server/staff-email-change.ts`) guard `/change-email` whichever door it came through, `/api/staff/me/email` or `/api/auth/change-email`:
  - a person with an authenticator app or passkey needs a second-factor check from the last 10 minutes (`step_up_required`); a person with none is not asked;
  - the address must be free (`email_taken`, with a field error);
  - a change from or to a domain that requires company sign-in is refused (`company_sign_in_email`);
  - at most 5 requests an hour per client (`rateLimit.customRules`).
- After the request: a `requested` notice to the OLD address (outbox). After the link is opened: other devices are signed out, a `changed` notice goes to the OLD address, audit rows `staff.email.change_requested` and `staff.email.changed` (empty metadata). A link opened twice does nothing the second time.

## An owner or admin changes a teammate's (Team → ⋯ → Change email)

`POST /api/staff/team/members/[id]/email`, `changeMemberEmail` in `src/server/staff-email.ts`.

- Needs `team.manage` and a second-factor check from the last 10 minutes. Never on yourself (`own_email`), never on the owner (`owner_required`), only the owner on an admin (`owner_only`), not on a deactivated person, not on a login that also works in another business (`shared_login`), not from or to a company-sign-in domain.
- One transaction: email moved, **`emailVerified` set to false** (the manager typed the address, the person has not proved it; their next password sign-in sends a confirmation link and waits for it, and accepting an invite verifies it), every session deleted, reset and invite links killed, Google/Microsoft logins tied to the old address unlinked, a notice to the OLD address (`changed_by_admin`) and to the NEW address (`now_yours`), and the audit row `staff.member.email_changed` with `{ membershipId, inviteReissued, unlinkedLogins }` only.
- A person who has not accepted their invite gets a new invite at the new address afterwards (`sendStaffInvite`, which replaces the old link); the owner sees the link once, like the usual invite.

## Notices

Outbox event `account.email_notice` (`src/lib/staff-email.ts`). The address travels **sealed** in the payload (same AES-GCM sealing as booking email codes, tied to the business and the row), so the outbox holds no readable address; the dedupe key and aggregate id are a random id. The worker handler is `src/worker/handlers/account-email-notice.ts`; the template is `src/emails/account-email-change.tsx`. Without an email provider the worker dead-letters the row (`provider_not_configured`), as it does for booking codes.

## Known limits

- The confirmation link for the own flow is Better Auth's signed JWT, not a stored hashed token: it is valid for an hour and cannot be revoked before then, but it only works while the person's email is still the old one.
- Invite, reset and the own-change link are sent in the request, not through the outbox (a known gap in STATUS.md, medium issues).
- When one login can belong to several businesses (wave 2), `shared_login` makes a manager's change refuse; the person can still change their own.
- Passkeys and the authenticator app stay on the account after a manager changes the email.
- Browser journey for the profile dialog was not run (unit and integration only).
