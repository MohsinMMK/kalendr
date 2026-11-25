import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Opens a coss Select trigger and picks the option with the given visible label. */
export async function chooseOption(user: UserEvent, trigger: HTMLElement, label: string | RegExp) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: label }));
}

/** Opens the coss date picker trigger and picks a day from its popup, by accessible calendar label. */
export async function chooseDate(user: UserEvent, trigger: HTMLElement, day: string | RegExp) {
  await user.click(trigger);
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: day }));
}

/**
 * Runs a bar action by name: clicks it when it is shown in the row, otherwise opens each
 * ⋯ "More actions" menu until one holds it. jsdom has no layout, so bars start collapsed.
 * Pass several names to walk into submenus, ending with the item to pick.
 */
export async function runBarAction(user: UserEvent, ...path: (string | RegExp)[]) {
  const [first, ...rest] = path;
  const inline = screen.queryByRole("button", { name: first });
  if (inline) {
    await user.click(inline);
  } else {
    let found: HTMLElement | null = null;
    for (const more of screen.getAllByRole("button", { name: "More actions" })) {
      await user.click(more);
      const menu = await screen.findByRole("menu");
      found = within(menu).queryByRole("menuitem", { name: first });
      if (found) break;
      await user.keyboard("{Escape}");
    }
    if (!found) throw new Error(`No bar action named ${String(first)}`);
    await user.click(found);
  }
  for (const name of rest) {
    const menus = await screen.findAllByRole("menu");
    const item = [...menus[menus.length - 1].querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((node) =>
      typeof name === "string" ? node.textContent?.trim().startsWith(name) : name.test(node.textContent ?? ""),
    );
    if (!item) throw new Error(`No menu entry named ${String(name)}`);
    await user.click(item);
  }
}
