# ReUI, on coss

Components from [ReUI](https://reui.io/components) (MIT, keenthemes/reui), taken from its
Base UI registry style (`https://reui.io/r/base-nova/<name>.json`) and rewired onto this app's
coss parts instead of stock shadcn ones. `shadcn add` is not used, because it would overwrite
`src/components/ui/`.

What changed from the registry files:

- `cn` comes from `@/lib/utils`.
- shadcn `dropdown-menu` imports point at coss `menu`, `button-group` at coss `group`, and
  `ComboboxContent` at `ComboboxPopup`, as import aliases so ReUI's markup is untouched.
- `IconPlaceholder` is replaced with the `lucide-react` icon it names.
- `input-group-button.tsx` is new: coss has no `InputGroupButton`, so it is a ghost coss `Button`.
- The phone input's `"use client"` moved above its imports, and its field takes coss's `size` instead of fixed heights.
- Two type fixes: no `side` on the column menu's submenu (coss positions submenus itself), and
  the time picker passes only a string `className` to its `InputGroup`.

Included: cascader, data-grid, filters, phone-input, sortable, stepper, time-picker,
timeline. ReUI's Event Calendar is left out; Schedule uses KLOQ.

To update one, fetch it again from the registry and reapply the changes above.
