import { describe, expect, it } from "vitest";
import { type Deps, buildTools } from "../mcp/tools";
import { deps } from "./fakes";

async function run(d: Deps, name: string, args: Record<string, unknown>) {
  const tool = buildTools(d).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const r = await tool.run(args);
  return { text: r.content[0]?.text, data: r.structuredContent, error: r.isError ?? false };
}

/**
 * What the MCP tools answered before routes and quotes moved behind `lib/api/service.ts`. The
 * snapshots were written against the old code; the refactor must leave every figure unchanged.
 */
describe("MCP answers are unchanged by the service refactor", () => {
  const cases: Array<[string, Record<string, unknown>, Partial<Deps>?]> = [
    ["list_routes", {}],
    ["quote_transfer", { from: "stellar", to: "base", amount: "10" }],
    ["quote_transfer", { from: "stellar", to: "solana", amount: "1234.567891" }],
    ["quote_transfer", { from: "stellar", to: "base", amount: "1" }],
    ["quote_transfer", { from: "arc", to: "base", amount: "25.5" }],
    ["quote_transfer", { from: "arc", to: "base", amount: "0.1" }],
    ["quote_transfer", { from: "stellar", to: "monad", amount: "10" }],
    ["quote_transfer", { from: "stellar", to: "base", amount: "10" }, { circle: async () => null }],
  ];
  for (const [name, args, over] of cases) {
    it(`${name} ${JSON.stringify(args)}${over ? " (overridden deps)" : ""}`, async () => {
      expect(await run(deps(over), name, args)).toMatchSnapshot();
    });
  }
});
