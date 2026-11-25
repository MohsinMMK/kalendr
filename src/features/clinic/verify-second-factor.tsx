"use client";

import { useRouter } from "next/navigation";

import { SecondFactorForm } from "./second-factor-parts";
import { StaffSignOut } from "./staff-auth-controls";

/** The "Confirm it's you" step after a sign-in that has not yet used its second factor. */
export function VerifySecondFactor({
  hasAuthenticator,
  hasPasskey,
  destination,
}: {
  hasAuthenticator: boolean;
  hasPasskey: boolean;
  destination: string;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-4">
      <SecondFactorForm
        hasAuthenticator={hasAuthenticator}
        hasPasskey={hasPasskey}
        onVerified={() => {
          router.replace(destination);
          router.refresh();
        }}
      />
      <StaffSignOut />
    </div>
  );
}
