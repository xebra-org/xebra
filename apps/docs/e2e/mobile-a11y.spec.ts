import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// One page of each kind the site renders: the landing page, a plain MDX page, a guide with code
// samples, a generated API reference page and an error page. If a layout change breaks one of
// these at phone width or for a screen reader, it most likely breaks the rest of its kind too.
const PAGES = [
  { name: "home", path: "/docs" },
  { name: "quickstart", path: "/docs/quickstart" },
  { name: "guide", path: "/docs/guides/send-from-stellar" },
  { name: "api reference", path: "/docs/api/quotes/get-quote" },
  { name: "error", path: "/docs/errors/rate_limited" },
];

// axe impact levels that fail the build. Moderate and minor findings are reported, not blocking.
const BLOCKING = new Set(["serious", "critical"]);

for (const { name, path } of PAGES) {
  test.describe(`${name} (${path})`, () => {
    test.beforeEach(async ({ page }) => {
      const res = await page.goto(path, { waitUntil: "networkidle" });
      expect(res?.ok(), `${path} answered ${res?.status()}`).toBe(true);
    });

    test("has no horizontal scroll at 375 px", async ({ page }) => {
      const { scrollWidth, clientWidth, offenders } = await page.evaluate(() => {
        const root = document.documentElement;
        const width = root.clientWidth;
        // Name the widest elements that stick out, so a failure says what to fix.
        const offenders = [...document.body.querySelectorAll<HTMLElement>("*")]
          .filter((el) => el.getBoundingClientRect().right > width + 1)
          .filter((el) => !el.closest("pre, [data-overflow-allowed]"))
          .slice(0, 5)
          .map((el) => {
            const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
            return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} (right edge ${Math.round(el.getBoundingClientRect().right)}px)`;
          });
        return { scrollWidth: root.scrollWidth, clientWidth: width, offenders };
      });
      expect(
        scrollWidth,
        `page is ${scrollWidth}px wide in a ${clientWidth}px viewport; widest: ${offenders.join(", ")}`,
      ).toBeLessThanOrEqual(clientWidth);
    });

    test("has no serious or critical axe violations", async ({ page }, testInfo) => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      await testInfo.attach("axe-results.json", {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });

      const blocking = results.violations
        .filter((v) => v.impact && BLOCKING.has(v.impact))
        .map((v) => `${v.impact}: ${v.id} — ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`);

      expect(blocking, blocking.join("\n")).toEqual([]);
    });
  });
}
