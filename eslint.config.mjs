import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    // Other sessions' git worktrees live here; each is checked in its own folder.
    ".claude/**",
    "build/**",
    // The extension's built output.
    "integrations/browser-extension/dist/**",
    "next-env.d.ts",
    // KLOQ is copied in from its registry and updated from there. Its author's rules differ from ours.
    "src/components/kloq/**",
    // Stageshow is vendored from its repo (MIT, see its LICENSE) for the onboarding demo.
    "src/components/stageshow/**",
    // ReUI components, vendored from its registry (MIT) and rewired onto coss parts; see its README.
    "src/components/reui/**",
    // coss composer, copied from its registry as it ships; it does not follow this repo's React lint rules.
    "src/components/ui/composer.tsx",
    // coss chat, copied from its registry as it ships, for the same reason.
    "src/components/chat/**",
    "src/lib/composer-*.ts",
    "src/hooks/use-composer-editor.ts",
    // Browser-test output and the throwaway test database's files.
    ".e2e/**",
    "playwright-report/**",
    "test-results/**",
    // Bundled worker and migrate scripts (pnpm build:jobs).
    "dist/**",
  ]),
]);

export default eslintConfig;
