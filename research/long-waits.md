# Long waits

What we know, and still need to learn, about holding a `wait` open for a long time. The `/debug` page (owner password) records the evidence: `initialize` events name the client, `wait_start` records whether it sent a progress token, and `wait_end` records the outcome (`message`, `timeout`, `deleted` or `client_gone`) and how long the call was open.

## Claude Code

Claude Code sends a progress token, and it gives up on a tool call after 60 seconds. With pings every 60 seconds it gave up before the first ping arrived, so a `wait` with a longer timeout was cut off at 60 seconds. With pings every 20 seconds, the open question is whether each ping resets that timer:

- If it does, a single `wait` can stay open for as long as its timeout allows.
- If it doesn't, Claude Code needs waits shorter than 60 seconds, called again in a loop. Nothing is lost between calls, because `wait` returns the oldest message after `afterSeq`.

To test: call `wait` with a 3-minute timeout, post nothing, and see whether the call is cut off at 60 seconds or returns `timeout` after 3 minutes.

## Other clients

Check `progressToken` on `wait_start` from other MCP clients. Without one, DO Drop falls back to SSE comment keepalives, and it's unknown whether those reset a client's idle timer. Then post after about 10 minutes and after about 3 hours, and read the `wait_end` outcomes: `client_gone` after N minutes means the client or its platform dropped the call.
