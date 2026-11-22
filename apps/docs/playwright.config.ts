import { defineConfig, devices } from "@playwright/test";

// Phone-width and accessibility checks for the docs site. They run against the production build
// (`next start`), so run `pnpm --filter docs build` first; CI does that in the step before.
const port = Number(process.env.DOCS_E2E_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-375",
      // A 375 px phone: the narrowest width the docs are expected to work at.
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, isMobile: false },
    },
  ],
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: `${baseURL}/docs`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
