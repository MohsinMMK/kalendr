import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, sql, type SQL } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, mediaAssets, outboxEvents, services } from "@/db/schema";
import { isMediaKind, maxMediaBytes, mediaUrl, type MediaKind } from "@/lib/media";
import { ApiError } from "@/server/api-error";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

import { fileStoreKey, getFileStore } from "./file-store";
import { loadRecordKeys, openBytes, sealBytes, writeKeyVersion } from "./record-crypto";
import { uploadScanMode } from "./scan/clamav";
import { currentTraceParent } from "./tracing";
import { readMediaDimensions, sniffMediaType, type MediaContentType } from "./media-bytes";

export { readMediaDimensions, sniffMediaType, type MediaContentType } from "./media-bytes";

/** Business pictures plus staff photos. Staff photos come in through the team screens, not the media route. */
export type PictureKind = MediaKind | "practitioner";

/** Room for the multipart envelope around the file itself. */
const multipartAllowance = 16 * 1_024;

const tooLarge = () => new ApiError(413, "request_too_large", "Choose a picture smaller than 600 KB.");
const notAPicture = () => new ApiError(400, "unsupported_media_type", "Choose a JPEG or WebP picture.");

/** Refuses a request by its declared size before anything is read. */
export function checkDeclaredMediaSize(headers: Headers): void {
  const declared = Number.parseInt(headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > maxMediaBytes + multipartAllowance) throw tooLarge();
}

export interface CheckedMedia {
  contentType: MediaContentType;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** Every check that does not need the database. */
export function checkMediaBytes(bytes: Uint8Array, options: { allowPng?: boolean } = {}): CheckedMedia {
  if (bytes.length === 0) throw notAPicture();
  if (bytes.length > maxMediaBytes) throw tooLarge();
  const contentType = sniffMediaType(bytes, options);
  if (!contentType) throw notAPicture();
  const size = readMediaDimensions(bytes, contentType);
  if (!size || size.width > 4_096 || size.height > 4_096) {
    throw new ApiError(400, "unsupported_media_type", "This picture could not be read. Try another one.");
  }
  return { contentType, ...size, bytes };
}

export interface SavedMedia {
  id: string;
  kind: MediaKind;
  ownerId: string;
  url: string;
  /** pending until the virus scan passes; the picture is served only after that. */
  scanStatus: PictureScanStatus;
}

export type PictureScanStatus = "pending" | "clean" | "skipped";

/** Production never takes a file it can't scan. */
export function refuseUnscannedUploads(): void {
  if (uploadScanMode() === "refuse") {
    throw new ApiError(503, "scanner_unavailable", "Files can't be added until virus scanning is set up on this server.");
  }
}

/** Store keys written during a change. If the change fails they are removed again, so nothing is left behind. */
export type StoredFiles = string[];

export async function withStoredFiles<T>(work: (stored: StoredFiles) => Promise<T>): Promise<T> {
  const stored: StoredFiles = [];
  try {
    return await work(stored);
  } catch (error) {
    if (stored.length > 0) {
      const store = getFileStore();
      await Promise.allSettled(stored.map((key) => store.remove(key)));
    }
    throw error;
  }
}

/**
 * Objects whose rows were deleted in this transaction. The worker removes them once the
 * change has committed, so a change that rolls back never loses a file it still points at.
 */
export async function queueFileRemovalIn(transaction: KalendrTransaction, tenantId: string, keys: (string | null)[]): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    await transaction.insert(outboxEvents).values({
      tenantId,
      aggregateType: "file",
      aggregateId: key,
      eventType: "file.remove",
      payload: { key },
      dedupeKey: `file.remove:${key}`.slice(0, 200),
      traceParent: currentTraceParent(),
    }).onConflictDoNothing();
  }
}

/**
 * Seals a picture with the business's data key, puts it in the file store and replaces any
 * earlier picture of the same kind and owner. Each picture gets a new id, so its address is permanent.
 */
export async function replacePictureIn(
  transaction: KalendrTransaction,
  tenantId: string,
  picture: { kind: PictureKind; ownerId: string } & CheckedMedia,
  stored: StoredFiles,
): Promise<{ id: string; scanStatus: PictureScanStatus }> {
  const scanMode = uploadScanMode();
  if (scanMode === "refuse") refuseUnscannedUploads();
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  const id = randomUUID();
  const storageKey = fileStoreKey(tenantId, "media", id);
  const sealed = sealBytes(tenantId, picture.bytes);
  await getFileStore().put(storageKey, sealed);
  stored.push(storageKey);
  await removePicturesIn(transaction, tenantId, and(eq(mediaAssets.kind, picture.kind), eq(mediaAssets.ownerId, picture.ownerId))!);
  const scanStatus: PictureScanStatus = scanMode === "scan" ? "pending" : "skipped";
  await transaction.insert(mediaAssets).values({
    id,
    tenantId,
    kind: picture.kind,
    ownerId: picture.ownerId,
    contentType: picture.contentType,
    width: picture.width,
    height: picture.height,
    byteSize: picture.bytes.length,
    data: null,
    storageKey,
    keyVersion: writeKeyVersion(tenantId),
    scanStatus,
  });
  if (scanStatus === "pending") {
    await transaction.insert(outboxEvents).values({
      tenantId,
      aggregateType: "media_asset",
      aggregateId: id,
      eventType: "file.scan",
      payload: { table: "media_assets", id },
      dedupeKey: `file.scan:media_assets:${id}`,
      traceParent: currentTraceParent(),
    });
  }
  return { id, scanStatus };
}

/** Deletes picture rows and queues their stored objects for removal. */
export async function removePicturesIn(
  transaction: KalendrTransaction,
  tenantId: string,
  where: SQL,
): Promise<{ id: string; kind: string; ownerId: string }[]> {
  const removed = await transaction.delete(mediaAssets)
    .where(and(eq(mediaAssets.tenantId, tenantId), where))
    .returning({ id: mediaAssets.id, kind: mediaAssets.kind, ownerId: mediaAssets.ownerId, storageKey: mediaAssets.storageKey });
  await queueFileRemovalIn(transaction, tenantId, removed.map((row) => row.storageKey));
  return removed;
}

/** A staff photo from the team screens, as a data URL. Null removes the photo. */
export async function setPractitionerPhotoIn(
  transaction: KalendrTransaction,
  tenantId: string,
  practitionerId: string,
  dataUrl: string | null,
  stored: StoredFiles,
): Promise<void> {
  if (dataUrl === null) {
    await removePicturesIn(transaction, tenantId, and(eq(mediaAssets.kind, "practitioner"), eq(mediaAssets.ownerId, practitionerId))!);
    return;
  }
  const comma = dataUrl.indexOf(",");
  const bytes = new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), "base64"));
  const checked = checkMediaBytes(bytes, { allowPng: true });
  await replacePictureIn(transaction, tenantId, { kind: "practitioner", ownerId: practitionerId, ...checked }, stored);
}

/** The logo and cover are the business's face and have their own switch; a service picture comes with the service settings. */
export function permissionForPicture(kind: Exclude<MediaKind, "staff_photo">): "brand.manage" | "settings.manage" {
  return kind === "service" ? "settings.manage" : "brand.manage";
}

const auditAction: Record<MediaKind, string> = {
  business_logo: "settings.business.logo_updated",
  business_cover: "settings.business.cover_updated",
  service: "settings.service.updated",
  staff_photo: "staff.photo_updated",
};

/** Every signed-in staff member may change their own photo, and only their own; there is no switch for it. */
function requireOwnPhotoContext(context: StaffContext): string {
  if (context.preview) throw new ApiError(409, "preview_mode", "Preview does not save pictures.");
  if (!context.userId) throw new ApiError(403, "forbidden", "Sign in to change your photo.");
  return context.userId;
}

/**
 * Stores a business picture, replacing any earlier one of the same kind and
 * owner. The old row is deleted so each picture address stays permanent.
 */
export async function saveMedia(
  context: StaffContext,
  input: { kind: unknown; ownerId: unknown; bytes: Uint8Array },
): Promise<SavedMedia> {
  if (!isMediaKind(input.kind)) {
    requirePermission(context, "settings.manage");
    throw new ApiError(400, "validation_error", "Choose which picture this is.");
  }
  const kind = input.kind;
  // A person's own photo is owned by their login, whatever owner the request names.
  const ownPhotoOwner = kind === "staff_photo" ? requireOwnPhotoContext(context) : null;
  if (kind !== "staff_photo") requirePermission(context, permissionForPicture(kind));
  if (context.preview) {
    throw new ApiError(409, "preview_mode", "Preview does not save pictures.");
  }
  const checked = checkMediaBytes(input.bytes);
  const ownerId = ownPhotoOwner ?? (kind === "service" ? String(input.ownerId ?? "") : context.tenantId);
  if (!ownerId) throw new ApiError(400, "validation_error", "Choose the service for this picture.");

  refuseUnscannedUploads();

  return withStoredFiles((stored) => withTenant(context.tenantId, async (transaction) => {
    if (kind === "service") {
      const [service] = await transaction
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.tenantId, context.tenantId), eq(services.id, ownerId)))
        .limit(1);
      if (!service) throw new ApiError(404, "service_not_found", "Service not found.");
    }
    const created = await replacePictureIn(transaction, context.tenantId, { kind, ownerId, ...checked }, stored);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: auditAction[kind], outcome: "success",
      metadata: kind === "service" ? { serviceId: ownerId, picture: "added" } : { picture: "added" },
    });
    return { id: created.id, kind, ownerId, url: mediaUrl(context.clinicSlug, created.id), scanStatus: created.scanStatus };
  }));
}

export async function deleteMedia(context: StaffContext, mediaId: string): Promise<{ id: string }> {
  if (context.preview) {
    throw new ApiError(409, "preview_mode", "Preview does not save pictures.");
  }
  return withTenant(context.tenantId, async (transaction) => {
    // The logo and cover need their own permission, services the settings one, a person's own photo none (but it must be theirs): check which picture this is first.
    const [found] = await transaction
      .select({ kind: mediaAssets.kind, ownerId: mediaAssets.ownerId })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.tenantId, context.tenantId), eq(mediaAssets.id, mediaId)))
      .limit(1);
    if (found?.kind === "staff_photo") {
      // Someone else's photo looks like a picture that does not exist.
      if (found.ownerId !== requireOwnPhotoContext(context)) throw new ApiError(404, "media_not_found", "Picture not found.");
    } else {
      if (!can(context, "settings.manage") && !can(context, "brand.manage")) requirePermission(context, "settings.manage");
      if (found && isMediaKind(found.kind) && found.kind !== "staff_photo") requirePermission(context, permissionForPicture(found.kind));
    }
    // Staff photos are changed on the team screens, not here.
    const [removed] = await removePicturesIn(transaction, context.tenantId, sql`${mediaAssets.id} = ${mediaId} and ${mediaAssets.kind} <> 'practitioner'`);
    if (!removed) throw new ApiError(404, "media_not_found", "Picture not found.");
    const kind = isMediaKind(removed.kind) ? removed.kind : "service";
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: auditAction[kind], outcome: "success",
      metadata: kind === "service" ? { serviceId: removed.ownerId, picture: "removed" } : { picture: "removed" },
    });
    return { id: removed.id };
  });
}

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
}

interface MediaRow extends Record<string, unknown> {
  content_type: string;
  data: Buffer | Uint8Array | null;
  storage_key: string | null;
  scan_status: string;
}

/**
 * Reads a public picture. The business comes from the slug, and the row is
 * read under that business's row-level security, so another business's
 * picture id never resolves through this slug.
 */
export async function readPublicMedia(
  businessSlug: string,
  mediaId: string,
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const database = getDatabase();
  if (!database) return null;
  const resolved = await database.execute<TenantRow>(sql`select * from kalendr_resolve_tenant(${businessSlug}, null)`);
  const tenant = resolved[0];
  if (!tenant) return null;
  const row = await withTenant(tenant.tenant_id, async (transaction) => {
    const [found] = await transaction.execute<MediaRow>(sql`
      select content_type, data, storage_key, scan_status from media_assets
      where tenant_id = ${tenant.tenant_id} and id = ${mediaId}
      limit 1
    `);
    // A picture is served only once its virus scan has passed.
    if (!found || !servable(found.scan_status)) return null;
    if (found.storage_key) await loadRecordKeys(transaction, tenant.tenant_id);
    return found;
  });
  if (!row) return null;
  if (!row.storage_key) return row.data ? { contentType: row.content_type, bytes: new Uint8Array(row.data) } : null;
  const sealed = await getFileStore().get(row.storage_key);
  return { contentType: row.content_type, bytes: new Uint8Array(openBytes(tenant.tenant_id, sealed)) };
}

function servable(scanStatus: string): boolean {
  return scanStatus === "clean" || scanStatus === "skipped";
}

interface MediaIdRow extends Record<string, unknown> {
  id: string;
  kind: string;
  owner_id: string;
}

/** Picture addresses for a business, ids only. */
export async function loadMediaUrlsIn(
  transaction: KalendrTransaction,
  tenantId: string,
  businessSlug: string,
): Promise<{
  logoUrl: string | null;
  coverUrl: string | null;
  serviceImages: Map<string, string>;
  practitionerPhotos: Map<string, string>;
}> {
  // Pictures still waiting for their virus scan are left out until the scan passes.
  const rows = await transaction.execute<MediaIdRow>(sql`
    select id, kind, owner_id from media_assets
    where tenant_id = ${tenantId} and scan_status in ('clean', 'skipped')
  `);
  let logoUrl: string | null = null;
  let coverUrl: string | null = null;
  const serviceImages = new Map<string, string>();
  const practitionerPhotos = new Map<string, string>();
  for (const row of rows) {
    const url = mediaUrl(businessSlug, row.id);
    if (row.kind === "business_logo") logoUrl = url;
    else if (row.kind === "business_cover") coverUrl = url;
    else if (row.kind === "service") serviceImages.set(row.owner_id, url);
    else if (row.kind === "practitioner") practitionerPhotos.set(row.owner_id, url);
  }
  return { logoUrl, coverUrl, serviceImages, practitionerPhotos };
}

/** The signed-in person's own photo address (kind staff_photo), or null. Pictures still being virus-scanned are left out. */
export async function findOwnStaffPhotoUrl(context: StaffContext): Promise<string | null> {
  if (context.preview || !context.userId) return null;
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ id: string } & Record<string, unknown>>(sql`
      select id from media_assets
      where tenant_id = ${context.tenantId} and kind = 'staff_photo' and owner_id = ${userId}
        and scan_status in ('clean', 'skipped')
      limit 1
    `);
    return row ? mediaUrl(context.clinicSlug, row.id) : null;
  });
}
