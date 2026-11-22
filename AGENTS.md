# AGENTS.md

DO Drop is a remote MCP server on one Cloudflare Worker and one SQLite-backed Durable Object. A signed-in session calls `wait(key)` and blocks; anyone who knows the key posts to it with `POST /drop` and the key as a bearer token, and the wait returns the payload. The MCP endpoint is behind OAuth with an owner password. Human docs are in [README.md](README.md); settled design decisions are in [docs/design.md](docs/design.md). Read the decisions before changing behavior.

## Commands

Everything runs through mise. Run `mise run setup` once, then:

- `mise run check`: every linter and the standards checks (hk: rumdl, prettier, eslint, tsc, gitleaks, jactionlint).
- `mise run fix`: apply formatter fixes.
- `mise run test`: the Vitest suite, run inside workerd by `@cloudflare/vitest-plugin`.
- `mise run ci`: what CI runs (`check` and `test`).
- `mise run dev`: `wrangler dev` at `https://localhost:8787`, owner password `testpassword`, 5 s pings.

Done means `mise run ci` passes. The tests run the whole flow in workerd, including OAuth sign-in (`test/oauth.ts`).

Every merge to `main` deploys to production: the Push to Main workflow runs CI and then `mise run deploy`. Don't merge anything that isn't ready to ship.

## Layout

- `src/index.ts`: the Worker (OAuth provider and routing) and the `Drop` Durable Object (storage, MCP, public post, expiry alarm, sign-in lockout, debug).
- `src/auth.ts`: the sign-in page and HTTP Basic auth for `/debug`, both checking `OWNER_PASSWORD`.
- `src/limits.ts`: limits shared with the tests.
- `test/drop.test.ts`: Vitest tests. `test/oauth.ts`: helpers that sign in the way claude.ai does.

## Rules

- `src/index.ts` may export only the default handler and `Drop`. workerd refuses to start a Worker whose entry module exports anything else; a test guards this. Put shared constants in another module.
- Keep the key-to-Durable-Object mapping in `stubFor`, so the drop can move to one object per key later.
- Keep the MCP layer dependency-free. OAuth uses `@cloudflare/workers-oauth-provider`; don't hand-roll token handling.
- Escape everything on the sign-in page that comes from the client (its name, the redirect host).
- Public posts only reach keys a signed-in session has opened, and a malformed key and an unopened one get the same `404`.
- Tool descriptions must say that payloads are untrusted data.
- A change to stored data or the Durable Object class needs a new `[[migrations]]` entry in `wrangler.toml`.
- Never print `OWNER_PASSWORD`. Locally use `testpassword`; in production it's a Wrangler secret.
- Docs: American spelling, no em dashes, a colon after bold bullet headings. Write the product name as **DO Drop**, and keep "Cloudflare" out of the name.
