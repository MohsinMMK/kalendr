import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { maxMediaBytes } from "@/lib/media";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

import {
  checkDeclaredMediaSize,
  deleteMedia,
  checkMediaBytes,
  readMediaDimensions,
  saveMedia,
  sniffMediaType,
} from "./media";

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    // APP0, 16 bytes long, skipped on the way to the frame header.
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // Start of frame: length, precision, height, width, components.
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function webpExtendedHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([..."RIFF"].map((char) => char.charCodeAt(0)), 0);
  bytes.set([..."WEBP"].map((char) => char.charCodeAt(0)), 8);
  bytes.set([..."VP8X"].map((char) => char.charCodeAt(0)), 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return bytes;
}

const ownerContext = (overrides: Partial<StaffContext> = {}): StaffContext => ({
  tenantId: "tenant-a",
  clinicSlug: "business-a",
  clinicName: "Business A",
  role: "owner",
  permissions: resolvePermissions("owner", {}),
  membershipId: null,
  userId: "user-a",
  userName: "Owner",
  userEmail: "owner@example.com",
  preview: false,
  ...overrides,
});

describe("business picture checks", () => {
  it("decides the type from the bytes, never the name", () => {
    expect(sniffMediaType(jpegHeader(10, 10))).toBe("image/jpeg");
    expect(sniffMediaType(webpExtendedHeader(10, 10))).toBe("image/webp");
    // PNG, GIF and SVG are refused even though browsers can show them.
    expect(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("reads the pixel size from JPEG and WebP headers", () => {
    expect(readMediaDimensions(jpegHeader(960, 720), "image/jpeg")).toEqual({ width: 960, height: 720 });
    expect(readMediaDimensions(webpExtendedHeader(1600, 900), "image/webp")).toEqual({ width: 1600, height: 900 });
  });

  it("reads the size of real WebP files", () => {
    const folder = path.join(process.cwd(), "public", "onboarding");
    const files = readdirSync(folder).filter((name) => name.endsWith(".webp"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const checked = checkMediaBytes(new Uint8Array(readFileSync(path.join(folder, name))));
      expect(checked.contentType).toBe("image/webp");
      expect(checked.width).toBeGreaterThan(0);
      expect(checked.height).toBeGreaterThan(0);
    }
  });

  it("refuses empty, oversized, unknown and unreadable pictures", () => {
    expect(() => checkMediaBytes(new Uint8Array())).toThrow(expect.objectContaining({ status: 400, code: "unsupported_media_type" }));
    expect(() => checkMediaBytes(new Uint8Array(maxMediaBytes + 1))).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => checkMediaBytes(new TextEncoder().encode("not a picture at all"))).toThrow(/JPEG or WebP/);
    expect(() => checkMediaBytes(webpExtendedHeader(5_000, 100))).toThrow(/could not be read/);
    expect(() => checkMediaBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/could not be read/);
    expect(checkMediaBytes(jpegHeader(256, 256))).toMatchObject({ contentType: "image/jpeg", width: 256, height: 256 });
  });

  it("refuses a request by its declared size before reading it", () => {
    expect(() => checkDeclaredMediaSize(new Headers({ "content-length": String(5 * 1_024 * 1_024) }))).toThrow(
      expect.objectContaining({ status: 413 }),
    );
    expect(() => checkDeclaredMediaSize(new Headers({ "content-length": String(maxMediaBytes) }))).not.toThrow();
    expect(() => checkDeclaredMediaSize(new Headers())).not.toThrow();
  });

  it("saves nothing in preview and needs a known kind of picture", async () => {
    await expect(
      saveMedia(ownerContext({ preview: true }), { kind: "business_logo", ownerId: null, bytes: jpegHeader(256, 256) }),
    ).rejects.toMatchObject({ status: 409, code: "preview_mode" });
    await expect(
      saveMedia(ownerContext(), { kind: "favicon", ownerId: null, bytes: jpegHeader(256, 256) }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
    await expect(
      saveMedia(ownerContext(), { kind: "service", ownerId: "", bytes: jpegHeader(960, 720) }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
  });

  it("lets any signed-in staff member set their own photo, with no switch, but never in preview", async () => {
    const desk = ownerContext({ role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
    // Past the permission check (a receptionist has no brand.manage): the next thing to stop it is the picture itself.
    await expect(saveMedia(desk, { kind: "staff_photo", ownerId: "someone-else", bytes: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ status: 400, code: "unsupported_media_type" });
    await expect(saveMedia({ ...desk, preview: true }, { kind: "staff_photo", ownerId: null, bytes: jpegHeader(256, 256) })).rejects.toMatchObject({ status: 409, code: "preview_mode" });
    await expect(saveMedia({ ...desk, userId: null }, { kind: "staff_photo", ownerId: null, bytes: jpegHeader(256, 256) })).rejects.toMatchObject({ status: 403 });
    // Removing is checked inside the transaction, and preview is refused before it.
    await expect(deleteMedia({ ...desk, preview: true }, "m1")).rejects.toMatchObject({ status: 409, code: "preview_mode" });
  });

  it("needs the logo-and-cover switch for the logo and cover, and business settings for a service picture", async () => {
    // A receptionist has neither by default.
    const desk = ownerContext({ role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
    for (const kind of ["business_logo", "business_cover", "service"]) {
      await expect(saveMedia(desk, { kind, ownerId: "s1", bytes: jpegHeader(256, 256) })).rejects.toMatchObject({ status: 403 });
    }
    // Switched on for them, the logo gets past the permission check (preview then stops it before anything is saved).
    const allowed = ownerContext({ role: "receptionist", preview: true, permissions: resolvePermissions("receptionist", { "brand.manage": true }) });
    await expect(saveMedia(allowed, { kind: "business_logo", ownerId: null, bytes: jpegHeader(256, 256) })).rejects.toMatchObject({ code: "preview_mode" });
    await expect(saveMedia(allowed, { kind: "service", ownerId: "s1", bytes: jpegHeader(256, 256) })).rejects.toMatchObject({ status: 403 });
    // Admins have it unless it is switched off.
    expect(resolvePermissions("admin", {})).toContain("brand.manage");
    expect(resolvePermissions("admin", { "brand.manage": false })).not.toContain("brand.manage");
  });
});
