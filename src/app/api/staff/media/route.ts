import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { checkDeclaredMediaSize, saveMedia } from "@/server/media";
import { can, getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Adds or replaces a business logo, cover, or service photo. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    checkDeclaredMediaSize(request.headers);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "validation_error", "Choose a picture to upload.");
    }
    // Refuse before reading the file unless they may change some picture (anyone may change their own photo);
    // saveMedia checks the exact kind.
    if (form.get("kind") !== "staff_photo" && !can(context, "brand.manage")) requirePermission(context, "settings.manage");
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "validation_error", "Choose a picture to upload.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return dataResponse(await saveMedia(context, { kind: form.get("kind"), ownerId: form.get("ownerId"), bytes }), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.media.save", requestId);
  }
}
