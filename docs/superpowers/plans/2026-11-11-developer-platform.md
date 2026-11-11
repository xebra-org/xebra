# Xebra developer platform: overview

Four plans, one per subsystem. Each ships working software on its own; together they are what an
integrator such as LOBSTR needs: a typed SDK, a public REST API with webhooks, a way to earn on the
transfers they send us, and documentation good enough to integrate without talking to us.

| # | Plan | Ships | Blocks on the user |
|---|------|-------|--------------------|
| 1 | [SDK and API](./2026-11-11-01-sdk-and-api.md) | `@xebra/sdk`, `/v1/*` on `api.xebra.exchange`, `openapi.json` | `api.xebra.exchange` domain in Vercel; npm org for publishing |
| 2 | [Docs site](./2026-11-11-02-docs-site.md) | `apps/docs` on `docs.xebra.exchange` | new Vercel project + domain |
| 3 | [API keys and webhooks](./2026-11-11-03-keys-and-webhooks.md) | keys, rate limits, signed webhooks, idempotency | Convex production env vars |
| 4 | [Integrator fees](./2026-11-11-04-integrator-fees.md) | wrapper v3 (Soroban) + EVM wrapper v2 with an integrator fee | mainnet deploys, audit, cutover |

Order: 1, then 2 (the docs read plan 1's `openapi.json` and SDK types; content work can start as
soon as plan 1 task 4 lands), then 3, then 4. Plan 4 is the long pole: contracts, audit, mainnet.

## Architecture

```
                    docs.xebra.exchange (apps/docs, Fumadocs, Next 16)
                         │ reads packages/sdk/openapi.json + SDK types at build
                         ▼
 integrator app ──► @xebra/sdk ──HTTP──► api.xebra.exchange/v1/*  (apps/web route handlers)
   (signs in its         │ core: chains, amounts, fees,            │
    own wallet)          │ addresses, tx builders (pure)           ├─ lib/api/service.ts ◄── /mcp tools
                         └───────── same core ─────────────────────┤
                                                                   ├─ Soroban RPC, EVM RPC, Sui gRPC
                                                                   ├─ Circle Iris (existing budget)
                                                                   └─ Convex: keys, webhooks, watches (plan 3)
```

Principles that hold in every plan:
- **Never custodial.** The API builds unsigned transactions; the integrator's user signs. No endpoint
  takes a private key or a signed-by-us transaction.
- **One code path.** The web app, `/mcp` and `/v1` call the same service layer and the same SDK core,
  so a quote is the same number everywhere.
- **The chain is the source of truth.** Routes come from the wrapper's committed domains, fees from
  its params and Circle's live quote, never from a config file alone.

## Docs build: research and decision (2026-11-11)

Candidates checked: Mintlify (hosted), Fumadocs (Next.js, MIT), Starlight (Astro), Nextra 4,
Docusaurus; for API reference Scalar and Fumadocs OpenAPI; for SDKs Stainless, Speakeasy, Fern.

**Decision: Fumadocs** (`fumadocs-ui`/`fumadocs-core` 16.18.4, `fumadocs-mdx` 15.5.3,
`fumadocs-openapi` 12.6.0, `fumadocs-twoslash` 4.0.4, Next 16.4.6), self-hosted on Vercel at
`docs.xebra.exchange`:
- Same stack as the site (Next, React, Tailwind, Geist, Vercel), so the brand is ours to the pixel:
  obsidian and bone, the crossing mark. Hosted platforms theme within their template.
- OpenAPI pages with a request playground generated from our own spec; Twoslash compiles every SDK
  sample against the real `@xebra/sdk` types, so a sample that would not compile fails the build.
- Built-in search, `llms.txt`, per-page Markdown for AI tools, MIT licence, $0.
- Content is MDX in git, so leaving later (to Mintlify, say) is a copy, not a rewrite.

Why not the others: Mintlify is the fastest to a polished site, but its AI assistant needs Pro at
about $450 a month (annual) and the look is its template, not ours. Starlight's API reference relies
on thinner community plugins. Nextra has weaker versioning and no first-party OpenAPI. Docusaurus
looks dated without heavy theming.

**SDK generation: hand-written.** Our SDK's core job is building chain transactions (Soroban XDR,
EVM calldata, Sui PTBs), which no OpenAPI generator does. The thin HTTP client is typed from the same
zod schemas that produce `openapi.json`. Stainless was reported acquired by Anthropic (WorkOS,
2026-05-27) and Fern by Postman; revisit Speakeasy only if we need Python or Go clients.

Sources: [Fumadocs vs Nextra v4 vs Starlight 2026](https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026),
[Fumadocs v16](https://fumadocs.dev/blog/v16), [fumadocs-openapi v11](https://fumadocs.dev/blog/openapi-v11),
[Mintlify alternatives](https://context7.com/mintlify-alternatives), [Mintlify pricing](https://www.featurebase.app/blog/mintlify-pricing.md),
[Scalar vs Mintlify](https://scalar.com/resources/compare/mintlify), [Stainless alternatives (WorkOS)](https://workos.com/blog/stainless-alternatives),
[Speakeasy vs Stainless vs Fern](https://apiscout.dev/guides/speakeasy-vs-stainless-vs-fern-sdk-generation-2026).
Package versions read from the npm registry on 2026-11-11.

## What the user does (in order)

1. Vercel, project `xebra` (web): add domain `api.xebra.exchange` (plan 1, task 6).
2. npm: create or confirm the `@xebra` org and add an automation token as the GitHub secret
   `NPM_TOKEN` (plan 1, task 8). If `@xebra` is taken, the fallback name is `@xebra-exchange/sdk`.
3. Vercel: new project `xebra-docs`, root directory `apps/docs`, domain `docs.xebra.exchange`
   (plan 2, task 7).
4. Convex production: env vars named in plan 3, task 1.
5. Plan 4: approve the v3 parameters, commission the audit, run the mainnet deploys and the cutover.
