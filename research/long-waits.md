# Long waits

What we've learned about holding a `wait` open, and what's still open. The `/debug` page (owner password) records the evidence: `initialize` events name the client, `wait_start` records whether it sent a progress token, `cancelled` records cancellation notices, and `wait_end` records the outcome (`message`, `timeout`, `deleted` or `client_gone`) and how long the call was open.

## Claude Code

Claude Code sends a progress token, and it gives up on a tool call after 60 seconds whatever the pings: a 3-minute wait with pings every 20 seconds was cut off at 60 seconds. Its calls reach DO Drop through a connector service, and the server never saw the client leave: that wait ran its full 3 minutes and sent all 8 pings. So waits default to 50 seconds, and clients call `wait` again or check back later.

Still open: does Claude Code send `notifications/cancelled` when it gives up? Look for `cancelled` events after a wait is cut off. If it does, a cancellation could end the matching wait, which would need DO Drop to track MCP sessions, since request ids are only unique within one.

## Other clients

Check `progressToken` on `wait_start` from other MCP clients, then try waits close to the 600-second maximum and read the `wait_end` outcomes. A client that holds long calls can pass a larger `timeoutSeconds`; one that doesn't should keep the default.
