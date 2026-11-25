import { readPublicMedia } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idPattern = /^[A-Za-z0-9-]{1,64}$/;
const slugPattern = /^[a-z0-9-]{1,80}$/;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

/** A business picture. Ids are permanent: a replaced picture gets a new id. */
export async function GET(
  _request: Request,
  route: { params: Promise<{ clinicSlug: string; id: string }> },
): Promise<Response> {
  const { clinicSlug, id } = await route.params;
  if (!slugPattern.test(clinicSlug) || !idPattern.test(id)) return notFound();
  try {
    const media = await readPublicMedia(clinicSlug, id);
    if (!media) return notFound();
    return new Response(Buffer.from(media.bytes), {
      status: 200,
      headers: {
        "Content-Type": media.contentType,
        "Content-Length": String(media.bytes.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return notFound();
  }
}
