# Long waits

Open questions to answer once DO Drop is deployed. The `/<SECRET>/debug` endpoint records what's needed: `initialize` events name the client, `wait_start` records whether it sent a progress token, and `wait_end` records the outcome (`message`, `timeout` or `client_gone`) and how long the call was open.

## Does Claude send a progress token?

Check `progressToken` on `wait_start` events from Claude Code, claude.ai connectors and cloud routines. Remote MCP clients drop a call after about 5 minutes without activity. If a client sends no token, DO Drop falls back to SSE comment keepalives, and it's unknown whether those reset the client's idle timer.

## How long does a session stay connected?

Post an answer after about 10 minutes, then after about 3 hours, and read the `wait_end` outcomes. A `client_gone` after N minutes means the client or platform dropped the call. If calls drop well before the 360-minute default, lower the default so clients get a clean `timeout` and call `wait` again.
