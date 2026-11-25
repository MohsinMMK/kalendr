"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    // Without this, a password sign-in that needs a code would look like a plain failure.
    twoFactorClient(),
    passkeyClient(),
    magicLinkClient(),
  ],
});
