# DO Drop

MCP dead drop on a Durable Object: post from anywhere, and the waiting AI session gets it.

> **Status:** working prototype, still questionnaire-specific (tools `wait_for_answers` / `get_answers` / `submit_answers`). See CLAUDE.md for the plan to generalize it into `wait` / `post` / `get` / `delete`.


A small remote MCP server (currently the questionnaire prototype) that lets a Claude session wait for answers
to a Questionnaire set and get them back in the same session.

```
session ──wait_for_answers(setId)──▶ relay   (held open; progress ping every 60 s)
page    ──submit_answers(setId, …)──▶ relay   (Submit on the Questionnaire page)
relay   ──answers────────────────────▶ session (the waiting call returns)
```

One Cloudflare Worker plus one SQLite-backed Durable Object. Every waiting
call shares that one object, so run-time billing doesn't multiply with the
number of waiting sessions.

## Tools

| tool | who calls it | what it does |
|---|---|---|
| `wait_for_answers(setId, maxWaitMinutes=360)` | the asking session | Blocks until the set is submitted and returns the answers. Returns `{"status":"waiting"}` if time runs out; call again to keep waiting. Returns at once if already submitted. |
| `get_answers(setId)` | anyone | Non-blocking check: `submitted` with answers, or `not_submitted`. |
| `submit_answers(setId, answers)` | the Questionnaire page | Stores the answers and wakes every call waiting on `setId`. |

The answers come back in the page's format: `{status, setId, submittedAt, answers: {questionId: {value, note, skipped, …}}, generalNote}`.

## Deploy

```bash
npm install
npx wrangler login
openssl rand -hex 24                 # copy the output; this is your SECRET
npx wrangler secret put SECRET       # paste it
npx wrangler deploy                  # prints https://do-drop.<you>.workers.dev
```

Your MCP endpoint is `https://do-drop.<you>.workers.dev/<SECRET>/mcp`.
Anyone with that URL can call the relay, so treat it like a password.

## Connect it to Claude

claude.ai → Settings → Connectors → **Add custom connector**

- Name: **Questionnaire Relay** (exactly this; the page calls the connector by name)
- URL: the MCP endpoint above
- No OAuth

The first time you press Submit on the Questionnaire page, claude.ai asks
whether the page may use Questionnaire Relay. Allow it.

## Debugging

`https://do-drop.<you>.workers.dev/<SECRET>/debug` shows which
calls are waiting right now and the last 100 events: initializes (with the
client's name), waits starting (including whether the client sent a
progress token), submits (and how many waiting calls they woke), and waits
ending (`answered`, `timeout` or `client_gone`, with duration).

That log is how to answer the open questions in the long-wait test:

- **Does the client send a progress token?** See `progressToken` on `wait_start`.
  Without one the relay falls back to SSE comment keepalives, which may not
  reset the client's idle timer.
- **How long does a session actually stay connected?** Look at `wait_end`.
  `client_gone` after N minutes means the client or platform dropped the call.

## Local development

```bash
printf 'SECRET=testsecret\nPING_SECONDS=5\n' > .dev.vars
npx wrangler dev
RELAY_URL=http://localhost:8787/testsecret/mcp npm test   # end-to-end smoke test
```

## Cost

Free plan: 100,000 requests/day and 13,000 GB-s/day of Durable Object run time.
While at least one wait is open the object is awake and billed as 128 MB,
so the free run time covers about 29 hours of waiting per day, shared across
all waits running at the same time. If you go over, calls error until the
daily reset; there's no bill unless you move to the $5/month paid plan.
