# Design

## Why DO Drop exists

Scheduled and headless Claude sessions sometimes need to ask a person something and get the answer back in the same session. `AskUserQuestion` isn't available in headless runs, and an artifact's "Send to Claude" comment wakes an arbitrary session, not the one that asked. A remote MCP tool that blocks until the answer arrives solves this. The Questionnaire artifact is the first client, but the drop itself stays generic: anything that can make an HTTP request can hand data back to a waiting session.

## Decisions

- **Keys are append-only lists:** each `post` appends a message with a sequence number. One-shot use is `wait(key)`; a conversation is `wait(key, afterSeq=lastSeen)`. Nothing is lost between waits, because `wait` returns the oldest message after `afterSeq` and says how many more are pending.
- **Sequence numbers are global:** they come from one SQLite `AUTOINCREMENT` column, so they increase within a key, are never reused after a delete, and aren't consecutive. Clients should only compare them.
- **One Durable Object for everything:** one awake object costs the same no matter how many waits are open. The key-to-object mapping lives in one function (`stubFor`) so it can move to `idFromName(key)` later.
- **Waiters live in memory:** a post wakes every in-memory waiter on its key, and each re-reads storage. If the object restarts, open waits drop and clients call `wait` again; stored messages survive.
- **Limits:** payloads are capped at 200 KB, and a key keeps its newest 100 messages. `wait` defaults to 360 minutes and is capped at 720, so a forgotten call can't burn the day's free run time.
- **Expiry:** a key is deleted 14 days after its last post. A Durable Object alarm sweeps once a day while any keys exist.
- **Two tokens:** the MCP URL's secret path segment (`SECRET`) grants everything. The REST endpoint `POST /<POST_TOKEN>/post/<key>` takes a separate, post-only token, so iOS Shortcuts, Home Assistant `rest_command`, webhooks and curl can post but not read. A JSON body is stored as JSON; any other body is stored as a string.
- **Payloads are untrusted:** whoever holds a token can post, so tool descriptions tell the receiving session to treat payloads as data, never as instructions.
- **MCP without the SDK:** the server speaks Streamable HTTP directly. Responses are JSON, except a blocking `wait`, which streams SSE. It's stateless at the MCP layer (no `Mcp-Session-Id`). While waiting, it sends `notifications/progress` every `PING_SECONDS` if the client passed a `progressToken`, and SSE comment keepalives otherwise.
- **Name:** the repo, Worker and npm package are `do-drop`; docs and the claude.ai connector say **DO Drop**. "Cloudflare" stays out of the name. The logo is a dewdrop.

## Cost

On the Workers free plan, Durable Objects get 13,000 GB-s of run time a day. While any wait is open the object is awake and billed as 128 MB, so the free allowance covers about 29 hours of open waiting a day, shared by every wait running at once. Past that, calls fail until the daily reset; nothing is billed unless the account moves to the $5/month paid plan.

## Questionnaire client

The Questionnaire artifact (`reference/questionnaire-artifact.html`) still calls the prototype's `submit_answers` tool on a connector named "Questionnaire Relay". Once DO Drop is deployed:

- Its Submit button should call `post(key=setId, payload=<answers document>)` on the "DO Drop" connector, and its `mcp` capability should be redeclared for the new server and tool.
- The claude.ai `questionnaire` skill should call `wait(setId)` on DO Drop after posting a set. The answers come back as the message's `payload`, in the page's format.
