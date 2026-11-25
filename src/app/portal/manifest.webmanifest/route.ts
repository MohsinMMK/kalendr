export const dynamic = "force-static";

/** The customer portal as its own installable app: it opens the portal, not the staff schedule. */
export function GET(): Response {
  return Response.json(
    {
      id: "/portal",
      name: "Kalendr visits",
      short_name: "My visits",
      description: "Your appointments, records and reminders.",
      start_url: "/portal",
      scope: "/portal",
      display: "standalone",
      orientation: "portrait-primary",
      background_color: "#ffffff",
      theme_color: "#262626",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } },
  );
}
