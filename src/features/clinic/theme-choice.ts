/** The theme choices and how to read them. No browser code here, so the server can use it too. */
export const themeCookie = "kalendr-theme";
export const themeChoices = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof themeChoices)[number];

export function parseTheme(value: string | undefined | null): ThemeChoice {
  return themeChoices.find((choice) => choice === value) ?? "light";
}

/** What the screen actually looks like: "system" follows the device. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}
