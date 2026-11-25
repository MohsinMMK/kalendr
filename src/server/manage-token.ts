import "server-only";

import { and, eq } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { appointments, retiredManageTokens, shortLinks } from "@/db/schema";

import { createOpaqueToken, sha256 } from "./crypto";
import { sealManageToken } from "./messaging/sealed-link";

/**
 * Gives a booking a fresh manage token (feature 8). Run inside the transaction that moves the booking and before its
 * outbox row is written, so the worker, which reads the sealed token when it sends, can only ever see the new one. The old
 * token stops matching at once, and any short link in an earlier text message is removed with it.
 */
export async function rotateManageToken(transaction: KalendrTransaction, tenantId: string, appointmentId: string): Promise<string> {
  // Remember who held the booking and which link was replaced. The old link still never manages anything; the
  // landing page only reads this to say the booking moved.
  const [current] = await transaction.select({ hash: appointments.manageTokenHash, patientId: appointments.patientId })
    .from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  if (current?.hash) {
    await transaction.insert(retiredManageTokens)
      .values({ tenantId, tokenHash: current.hash, appointmentId, patientId: current.patientId })
      .onConflictDoNothing();
  }
  const token = createOpaqueToken();
  await transaction.update(appointments)
    .set({ manageTokenHash: sha256(token), manageTokenCiphertext: sealManageToken(tenantId, appointmentId, token) })
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)));
  await transaction.delete(shortLinks).where(and(eq(shortLinks.tenantId, tenantId), eq(shortLinks.appointmentId, appointmentId)));
  return token;
}
