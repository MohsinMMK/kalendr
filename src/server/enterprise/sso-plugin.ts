import "server-only";

import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { recordAuthEvent } from "@/server/staff-security";

import { bindingMatches, redeemSsoTicket, SSO_BROWSER_COOKIE } from "./sso-state";

/**
 * The last step of company sign-in (feature 53). The provider's reply is checked by a plain route, which leaves a one-time ticket;
 * this endpoint trades the ticket for a Better Auth session. Making the session through Better Auth's own adapter means every
 * rule on sessions (a membership is needed, second factor, device notices) still applies, and no cookie is written by hand.
 * It is a GET so it works after the provider's cross-site redirect.
 */
export const companySignIn = () => ({
  id: "company-sign-in",
  endpoints: {
    completeCompanySignIn: createAuthEndpoint("/sso/complete", { method: "GET", query: z.object({ ticket: z.string().min(20).max(100) }) }, async (ctx) => {
      const failed = (code: string) => ctx.redirect(`/sign-in?error=${code}`);
      const ticket = await redeemSsoTicket(ctx.query.ticket);
      const browser = ctx.getCookie(SSO_BROWSER_COOKIE);
      // Used once either way.
      ctx.setCookie(SSO_BROWSER_COOKIE, "", { path: "/api", maxAge: 0 });
      // Only the browser that started this sign-in may finish it; otherwise a ticket from someone else's sign-in could be
      // opened in another person's browser and quietly sign them in as someone else.
      if (!ticket || !bindingMatches(browser, ticket.binding)) throw failed("sso_invalid_response");
      let session;
      try {
        session = await ctx.context.internalAdapter.createSession(ticket.userId);
      } catch {
        // The session rules said no (no active membership, for example).
        throw failed("sso_not_invited");
      }
      const user = await ctx.context.internalAdapter.findUserById(ticket.userId);
      if (!session || !user) throw failed("sso_provider_error");
      await setSessionCookie(ctx, { session, user });
      await recordAuthEvent(user.id, "staff.sso.sign_in", "success", { method: "company_sign_in" });
      throw ctx.redirect("/dashboard");
    }),
  },
});
