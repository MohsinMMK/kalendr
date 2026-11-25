# Customization wave (22 Nov 2026)

The owner asked that nothing in the staff app is fixed to one kind of business. Tables work like Notion (every column renamed, hidden, moved, and the business's own columns added and removed). The names of roles and sidebar entries are the business's own. Every picture can be cropped and adjusted before it is saved.

**Trunk:** `booking-side-panel`. Builders branch from it, merge its latest before finishing, and never merge into it themselves.

**Rules:** follow the builder rules in [WAVES.md](WAVES.md#rules-for-every-builder-session) and the standards in [STANDARDS.md](STANDARDS.md).
- Never migrate `.local-db`. Use a scratch PostgreSQL through `scripts/e2e-database.mjs`.
- Use the official coss compositions, and Drawer, never Sheet.
- Keep the Kloq calendar files untouched.

## Who owns which shared file

Only the owner of a file restructures it. Everyone else adds one-line hooks at most and says so in their report.

| File | Owner |
| --- | --- |
| `src/lib/workspace-layout.ts`, `src/components/customize-sheet.tsx`, `src/components/reui/data-grid/*` | A |
| `src/lib/terminology.ts`, `src/lib/business-types.ts`, `src/lib/permissions.ts`, `src/features/clinic/clinic-frame.tsx`, `business-profile-settings.tsx`, `clinic-command.tsx` | B |
| `src/components/image-upload.tsx`, `src/lib/image-resize.ts`, `src/lib/media.ts` | C |

## Migrations

| Lane | Number | Journal `when` |
| --- | --- | --- |
| A | `0077_…` | `1797400000000` |
| B | `0078_…` (only if needed) | `1797500000000` |
| C | none | none |

## Lane A: tables like Notion

**Storage.** Build on what exists; don't add a parallel system.
- Customers already have their own fields: `customer_field_definitions` and `customer_field_values` (`src/server/customers/fields.ts`, `/api/staff/customer-fields`).
- How each table is laid out for the business lives in `tenants.layout` (`src/lib/workspace-layout.ts`).
  - Column names, column order, hidden columns and widths are per business.
  - The business's own fields are per business, owners and admins only, as layouts are today.

**What you build:**
- **One shared column model for every staff grid:** Customers (`patients-grid.tsx`), Bookings (`bookings-table.tsx` / `bookings-columns.tsx`), Records (`records-grid.tsx`) and Follow-ups, if it is a grid.
  - Built-in columns can be renamed, hidden, shown again, moved (drag in the header, and from the column menu) and resized.
  - Use one header menu, as Notion does: Rename, Hide, Move left/right, Sort, Filter, plus Edit and Delete for the business's own fields.
  - A "Reset columns" action brings back the defaults.
- **Customers: the business's own fields as columns.**
  - A "+" at the end of the header adds a field. The kinds are text, number, date and choice; add multiple choice, yes/no, phone, email and link if the existing check constraint can be widened in 0077.
  - Fields can be renamed, have their kind and choices edited, and be deleted. Deleting archives the field, as `archivedAt` does today, and asks first.
  - Values show in the grid, can be edited in the cell (staff with customer edit permission), and show on the customer profile.
  - The grid filter and sort cover these fields.
- **Fields the system needs** (name, phone, email) can be renamed or hidden but not deleted. Say so in the UI with a lock, as `customize-sheet.tsx` does.
- **Column labels default to the business's words** (`useTerms`), so a salon's Customers table never says "Patient".
- **Privacy:** custom values must stay covered by privacy export, erasure, retention and customer merge. Check `src/server/privacy/*` and `src/server/customers/merge.ts`.
  - Values never go into audit metadata or logs.
  - Use zod, `withTenant` and row-level security.

**Done when:**
- Unit tests cover the column model (rename, hide, order, reset, unknown ids dropped) and field validation for each kind.
- An e2e journey, as the owner:
  - Renames the Customers "Phone" column, hides another, moves one, adds a choice field, sets a value in a cell and reloads; everything persists.
  - Deletes the field after confirming.
  - Checks that a receptionist sees the owner's layout but has no Add field or Delete.
- `expectAccessible` passes with the column menu open.
- The same rename, hide and reset works on Bookings and Records.

## Lane B: the business's own names, roles and sidebar

**Already exists:** Settings → Business profile edits seven words (customer, provider, business, appointment, service, resource, location) through `tenants.terminology` and `resolveBusinessProfile`. Build on it and keep it the single place for words.

**What you build:**
- **Role names.**
  - Every role's display name (Owner, Admin, Receptionist, the provider role, Billing, Read only) can be renamed per business, for example "Front desk" or "Team".
  - Store this in the business profile, so `resolveBusinessProfile` → `roleLabelsFor` / `roleDescriptionsFor` pick it up everywhere: Team page, invites, account menu, profile header, emails.
  - Role keys and permissions do not change.
- **A job title per staff member,** optional, such as "Senior stylist". It shows under their name in the sidebar account section and on Team.
- **Sidebar.**
  - Owners and admins can rename, hide and reorder sidebar entries, and rename the section headings, from one source.
  - That source also feeds the command palette, page titles, breadcrumbs, the product tour and help.
  - Settings, My profile and Help can't be hidden.
  - Permissions still decide who sees what; hiding an entry never grants or removes access.
  - Edit it from a "Customize sidebar" entry in Settings, and from the sidebar itself (a ⋯ on a section heading, or right-click).
- **Sweep the staff app for hard-coded business words** ("patient", "clinic", "practitioner", "doctor", "dental", "stylist"…) in user-facing text and route them through the terms. One example: My profile says "Your clinic owner can change this."
  - Code identifiers and routes stay as they are.
  - Clinical-only screens that already check `isClinicalBusinessType` may keep clinical words.

**Done when:**
- Unit tests cover role-name overrides (cleaned, length-limited, reset) and the sidebar model (rename, hide, order, locked entries, unknown ids dropped).
- An e2e journey on the seeded **wellness** business:
  - Renames the provider word to "Team", the receptionist role to "Front desk", and two sidebar entries; hides one entry and moves one; reloads.
  - The sidebar, command palette and page titles show the new names.
  - No sidebar page's visible text contains "patient", "clinic" or "practitioner" (check each page reachable from the sidebar).
- `expectAccessible` passes on the sidebar settings.

## Lane C: crop and adjust every picture

**What you build:**
- **One picture editor** opens after a file is chosen, before anything is uploaded, for every picture in the app:
  - The business logo and cover.
  - Service pictures.
  - Personal staff photos.
  - Practitioner/team photos. These take the second path: `photoToDataUrl` in `profile-workspace.tsx` and `doctors-workspace.tsx`, so move them onto the editor too.
  - Search for any other `<input type="file" accept="image…">`.
- **Controls:**
  - Drag to reposition and zoom (slider plus pinch and wheel).
  - Rotate 90°, straighten (a fine angle slider), flip.
  - Brightness, contrast and saturation sliders.
  - Reset.
  - The crop frame has the kind's shape (`mediaTargets`): round or rounded for photos and logos, wide for covers. Show the guides.
- **Output:** the result matches `mediaTargets` (and the data-URL photo size) exactly, and the upload pipeline and server checks stay unchanged.
- **"Adjust photo" on a saved picture** re-opens the editor on the stored picture. Originals aren't kept, so this re-crops what was saved; don't add original storage.
- **Library:** pick a proven, maintained cropper (for example `react-easy-crop`) at its latest version, styled to coss. Build the dialog from coss Dialog, Slider, Button, Tabs/Toggle Group and Tooltip.
- **Behaviour:**
  - The editor works with keyboard (arrow keys move, +/− zoom), touch and mouse, and with reduced motion.
  - It opens correctly from a Menu inside a Drawer (the profile header and the practitioner drawer).
  - On phones it uses the full screen.

**Done when:**
- Unit tests cover the crop and adjust maths: output size per kind, rotation and flip bounds, filters applied.
- An e2e journey intercepts the upload request (the test server has no virus scanner) and asserts the uploaded image's width and height for the logo, the cover and a personal photo after zooming and rotating.
- Cancel uploads nothing.
- `expectAccessible` passes with the editor open.
