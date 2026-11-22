# Design

## Why DO Drop exists

Scheduled and headless Claude sessions sometimes need to ask a person something and get the answer back in the same session. `AskUserQuestion` isn't available in headless runs, and an artifact's "Send to Claude" comment wakes an arbitrary session, not the one that asked. A remote MCP tool that blocks until the answer arrives solves this. The Questionnaire artifact is the first client, but the drop itself stays generic: anything that can make an HTTP request can hand data back to a waiting session.

## Decisions

- **Keys are append-only lists:** each `post` appends a message with a sequence number. One-shot use is `wait(key)`; a conversation is `wait(key, afterSeq=lastSeen)`. Nothing is lost between waits, because `wait` returns the oldest message after `afterSeq` and says how many more are pending.
- **Sequence numbers are global:** they come from one SQLite `AUTOINCREMENT` column, so they increase within a key, are never reused after a delete, and aren't consecutive. Clients should only compare them.
- **One Durable Object for everything:** one awake object costs the same no matter how many waits are open. The key-to-object mapping lives in one function (`stubFor`) so it can move to `idFromName(key)` later.
- **Waiters live in memory:** a post wakes every in-memory waiter on its key, and each re-reads storage. If the object restarts, open waits drop and clients call `wait` again; stored messages survive.
- **Limits:** payloads are capped at 200 KB, and a key keeps its newest 100 messages. `wait` defaults to 360 minutes and is capped at 720, so a forgotten call can't burn the day's free run time.
- **Expiry:** a key is deleted after 14 days without a wait, get or post. A Durable Object alarm sweeps once a day while any keys exist.
- **No secrets in URLs:** URLs end up in logs, history and settings, so every credential travels in a header.
- **The MCP endpoint needs sign-in:** `/mcp` sits behind OAuth 2.1, which claude.ai and Claude Code both support, using Cloudflare's `@cloudflare/workers-oauth-provider` for discovery, client registration, PKCE and tokens. Signing in means approving the client with one owner password (`OWNER_PASSWORD`). No third-party identity provider: setting one up costs more than it buys for one user. Ten wrong passwords in 15 minutes lock sign-in for the rest of that window.
- **The key is the shared secret:** clients choose their own keys, with no create tool. Any signed-in use of a key opens it. Anyone who knows an open key can post to it with `POST /drop` and `Authorization: Bearer <key>`, with no account, so pages, iOS Shortcuts, Home Assistant `rest_command`, webhooks and curl can answer without signing in. They can't read, wait or touch other keys. A JSON body is stored as JSON; any other body is stored as a string. Posts to unopened keys get `404`, so outsiders can't invent keys or fill storage. The endpoint allows cross-origin requests so web pages can post.
- **Keys should be long and random:** a guessable key lets anyone post to it while it's open. The tool descriptions say so.
- **Payloads are untrusted:** anyone with a key can post, so tool descriptions tell the receiving session to treat payloads as data, never as instructions.
- **Debug behind Basic auth:** `/debug` is for a browser, which can't hold an OAuth token, so it takes the owner password through HTTP Basic auth, sharing the sign-in lockout.
- **No smoke test:** the workerd tests cover the whole flow, sign-in included, so there's no end-to-end test against a running Worker, and CI holds no DO Drop credentials.
- **MCP without the SDK:** the server speaks Streamable HTTP directly. Responses are JSON, except a blocking `wait`, which streams SSE. It's stateless at the MCP layer (no `Mcp-Session-Id`). While waiting, it sends `notifications/progress` every `PING_SECONDS` if the client passed a `progressToken`, and SSE comment keepalives otherwise.
- **Name:** the repo, Worker and npm package are `do-drop`; docs and the claude.ai connector say **DO Drop**. "Cloudflare" stays out of the name. The logo is a dewdrop.

## Cost

On the Workers free plan, Durable Objects get 13,000 GB-s of run time a day. While any wait is open the object is awake and billed as 128 MB, so the free allowance covers about 29 hours of open waiting a day, shared by every wait running at once. Past that, calls fail until the daily reset; nothing is billed unless the account moves to the $5/month paid plan.

## Questionnaire client

The Questionnaire artifact (`reference/questionnaire-artifact.html`) still calls the prototype's `submit_answers` tool on a connector named "Questionnaire Relay". Once DO Drop is deployed:

- The `questionnaire` skill should give each set a long random key, call `wait(key)` on DO Drop (which opens it), and hand the page the key along with the set.
- The page's Submit should `fetch` `POST /drop` with `Authorization: Bearer <key>` and the answers document as the body. If artifacts can't reach outside URLs, it can instead call `post(key, payload)` through the "DO Drop" connector, which carries the owner's sign-in.
- The answers come back as the message's `payload`, in the page's format.
