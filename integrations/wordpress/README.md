# Kalendr Booking for WordPress

A small plugin: the `[kalendr_booking]` shortcode and a "Kalendr booking" block. Both print the one-script embed from
Kalendr's Share sheet (feature 52), built the same way as `embedSnippet` in `src/lib/embed/builder.ts`.

Package it with `scripts/package-wordpress-plugin.sh` (a zip in `dist/`). The plugin has no build step and no
dependencies. `src/lib/embed/wordpress-plugin.test.ts` keeps its output in step with the embed script.

Not yet done: a run on a real WordPress site (this machine has no PHP), and a listing on wordpress.org, which needs the
owner's account. See `docs/app-marketplace.md`.
