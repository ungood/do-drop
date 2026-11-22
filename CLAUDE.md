# DO Drop

A dead drop for AI sessions: one side **waits** on a key, the other side **posts** a JSON
payload to it, and the waiting call returns that payload — in the same Claude session
that asked. Built on one Cloudflare Worker + a SQLite-backed Durable Object ("DO" Drop).
Logo: a dewdrop.

## Why it exists

Jason's Claude routines need to ask him batches of questions and get the answers back
in the *same* session. AskUserQuestion isn't available in headless/scheduled runs, and
artifact "Send to Claude" comments wake an arbitrary session, not the asking one. A
remote MCP tool that blocks until the answer arrives solves it. The Questionnaire
artifact on claude.ai is the first client; the relay itself must stay generic.

## Current state (prototype, works locally)

`src/index.ts` is a working but questionnaire-specific prototype ("Questionnaire Relay"):

- Speaks MCP over Streamable HTTP directly (no SDK): JSON responses, SSE only for the
  long wait. Stateless at the MCP layer (no `Mcp-Session-Id`).
- Auth: secret path segment, `https://<host>/<SECRET>/mcp`; `/<SECRET>/debug` shows
  open waits and the last 100 events.
- One Durable Object (`idFromName("main")`) holds stored payloads (SQLite) and open
  waits (in memory). `submit` wakes waiters via in-memory resolvers.
- Tools: `wait_for_answers(setId, maxWaitMinutes=360)`, `get_answers(setId)`,
  `submit_answers(setId, answers)`.
- Wait loop sends `notifications/progress` every `PING_SECONDS` (60) when the client
  passed `_meta.progressToken`, else SSE comment keepalives. Returns
  `{status:"waiting"}` at the deadline. Detects client disconnect on the next write.
- `test/smoke.mjs` is an end-to-end test (`RELAY_URL=… npm test` against `wrangler dev`
  with `.dev.vars` = `SECRET=testsecret`, `PING_SECONDS=5`). It passed, as did manual
  timeout and disconnect tests.

`reference/questionnaire-artifact.html` is the current Questionnaire page (claude.ai
artifact `72a556cf-f8ef-437e-8a1a-f95ff8d08d96`). Its Submit calls
`mcp.callTool("Questionnaire Relay", "submit_answers", {setId, answers})` through the
artifact `mcp` capability. It must be updated to the generic `post` tool and the new
connector name once DO Drop is deployed.

## The job: generalize into DO Drop

Replace the questionnaire tools with a generic mailbox:

| tool | behavior |
|---|---|
| `wait(key, afterSeq=0, timeoutMinutes=360)` | Block until `key` has a message with `seq > afterSeq`; return it with its `seq`. Progress pings while waiting. `{status:"timeout"}` at the deadline. Immediate if one already exists. |
| `post(key, payload)` | Append a JSON message (size-capped, ~200 KB), wake waiters, return `{seq, woke}`. |
| `get(key, afterSeq=0)` | Non-blocking: messages after `afterSeq` (or the latest). |
| `delete(key)` | Remove a key and its messages. |

Decisions already made:

- **Each key is an append-only list with sequence numbers.** One-shot use = `wait(key)`;
  conversations = `wait(key, afterSeq=lastSeen)`. Nothing is lost between waits.
- **One Durable Object for everything** (cheapest: one awake object no matter how many
  waits). Keep the key → DO mapping in a single function so it can move to
  per-key `idFromName(key)` later.
- **Expiry:** delete keys idle for ~14 days via a DO alarm.
- **Plain REST endpoint too:** `POST /<postToken>/post/<key>` with a separate
  post-only token (env `POST_TOKEN`), so iOS Shortcuts, Home Assistant `rest_command`,
  webhooks and curl can post but not read.
- **Payloads are untrusted data** to the receiving session; say so in tool descriptions.
- Keep the MCP layer dependency-free unless the SDK clearly helps on Workers.
- Names: repo/Worker/npm `do-drop`; docs write **DO Drop**; claude.ai connector name
  "DO Drop". Don't put "Cloudflare" in the name.

## Open questions to test after deploy

1. Does Claude (Claude Code CLI, claude.ai connectors, cloud routines) send a
   `progressToken`? Check `wait_start` events in `/debug`. If not, do SSE comment
   keepalives reset the client's idle timer (5 min for remote MCP)?
2. How long does a cloud routine session actually stay connected on one open call?
   Test answering after ~10 minutes and after ~3 hours; read `wait_end` outcomes.

## Cost guardrails

Free plan: 13,000 GB-s/day of DO run time ≈ 29 hours of open waiting per day
(billed as 128 MB while any wait is open). Default and max wait limits keep a
forgotten call from burning the day. Paid plan is $5/month if outgrown.

## Follow-ups after DO Drop works

- Update the Questionnaire artifact: Submit → `post(key=setId, payload=answers doc)`
  on connector "DO Drop"; redeclare its `mcp` capability with the new server/tool.
- Update the claude.ai `questionnaire` skill: after posting a set, call
  `wait(setId)` on DO Drop; answers come back in the page's format.
- Optional: open-source it with a README pitched as "a dead drop that lets artifacts,
  webhooks and phones hand data back to a waiting AI session."
