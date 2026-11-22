# DO Drop

A dead drop for AI sessions: post from anywhere, and the waiting session gets it.

DO Drop is a small remote MCP server. A Claude session calls `wait` on a key and blocks. A web page, phone shortcut, webhook or another session posts a JSON payload to that key, and the waiting call returns it, in the same session that asked.

```text
session ──wait(key)──────────▶ DO Drop   (held open; progress ping every 60 s)
page    ──post(key, payload)─▶ DO Drop   (MCP tool, or the REST endpoint)
DO Drop ──payload────────────▶ session   (the waiting call returns)
```

It runs as one Cloudflare Worker and one SQLite-backed Durable Object ("DO" Drop). Every wait shares that one object, so run-time billing doesn't multiply with the number of waiting sessions.

## Tools

Each key holds an append-only list of messages. Every message gets a sequence number (`seq`) that is higher than any before it.

| Tool                                        | What it does                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait(key, afterSeq=0, timeoutMinutes=360)` | Blocks until `key` has a message with a `seq` greater than `afterSeq`, then returns the oldest one with its `seq` and how many more are `pending`. Returns at once if one is already there, and `{"status":"timeout"}` if time runs out (max 720 minutes). |
| `post(key, payload)`                        | Appends any JSON value (up to 200 KB), wakes every call waiting on the key, and returns `{seq, woke}`.                                                                                                                                                     |
| `get(key, afterSeq?)`                       | Doesn't wait. Without `afterSeq`, returns the latest message; with it, the messages after it, oldest first, up to 50.                                                                                                                                      |
| `delete(key)`                               | Deletes the key and its messages.                                                                                                                                                                                                                          |

For a one-shot answer, call `wait(key)`. For a conversation, pass the last `seq` you saw as `afterSeq`, so nothing posted between calls is missed.

A message looks like `{"seq": 7, "payload": {...}, "postedAt": "2026-11-22T17:00:00.000Z"}`. A key keeps its newest 100 messages and is deleted 14 days after its last post. Keys are 1 to 200 letters, digits or `. _ ~ : @ + -`.

## REST endpoint

Things that can't speak MCP can post with a plain HTTP request, using a separate post-only token:

```bash
curl -X POST "https://do-drop.<you>.workers.dev/<POST_TOKEN>/post/<key>" \
  -H 'Content-Type: application/json' -d '{"done": true}'
```

A JSON body is stored as JSON; anything else is stored as a string. The response is `{"key", "seq", "woke"}`. The post token can't read, wait or reach the MCP endpoint, so it's safe to put in an iOS Shortcut, a Home Assistant `rest_command` or a webhook.

## Deploy

You need a Cloudflare account (the free plan is enough) and [mise](https://mise.jdx.dev).

1. Install the tools and packages:

   ```bash
   mise run setup
   ```

2. Log in to Cloudflare. This opens a browser:

   ```bash
   pnpm exec wrangler login
   ```

3. Create the two secrets. Generate each with `openssl rand -hex 24`, save it in your password manager, then paste it when Wrangler asks. Use a different value for each.

   ```bash
   pnpm exec wrangler secret put SECRET
   pnpm exec wrangler secret put POST_TOKEN
   ```

   The first `secret put` offers to create the Worker if it doesn't exist yet. Say yes.

4. Deploy:

   ```bash
   mise run deploy
   ```

   Wrangler prints the Worker's URL, `https://do-drop.<you>.workers.dev`. If your account has no `workers.dev` subdomain yet, it asks you to pick one.

5. Run the smoke test against the deployment:

   ```bash
   DROP_URL=https://do-drop.<you>.workers.dev DROP_SECRET=<SECRET> DROP_POST_TOKEN=<POST_TOKEN> mise run smoke
   ```

   Add `POST_AFTER_MS=75000` to hold the wait past one 60-second progress ping and check that pings get through. The test deletes its key when it's done.

Your MCP endpoint is `https://do-drop.<you>.workers.dev/<SECRET>/mcp`. Anyone with that URL can read and post to every key, so treat it like a password. To rotate a token, run `secret put` again; the change applies without a redeploy.

## Continuous deployment

Every merge to `main` deploys. The Push to Main workflow runs CI, then a `deploy` job in the `production` environment runs `mise run deploy`. `SECRET` and `POST_TOKEN` stay in Cloudflare; a deploy doesn't change them.

To set it up:

1. In the Cloudflare dashboard, go to **My Profile**, then **API Tokens**, then **Create Token**, and use the **Edit Cloudflare Workers** template. Limit it to your account and save the token in your password manager.
2. Copy your account ID from the Workers & Pages overview page.
3. In the GitHub repo, go to **Settings**, then **Environments**, and create an environment named `production`. Add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Optionally, add yourself as a required reviewer to approve each deploy, and limit the environment to the `main` branch.

You still create `SECRET` and `POST_TOKEN` once with `wrangler secret put` (step 3 of [Deploy](#deploy)). After that, merging is deploying.

## Connect it to Claude

claude.ai, then Settings, Connectors, **Add custom connector**:

- **Name:** DO Drop
- **URL:** the MCP endpoint above
- **Auth:** none (the secret is in the URL)

For Claude Code, add it as a remote HTTP server:

```bash
claude mcp add --transport http do-drop "https://do-drop.<you>.workers.dev/<SECRET>/mcp"
```

## Debugging

`https://do-drop.<you>.workers.dev/<SECRET>/debug` shows the calls waiting right now, the 100 most recently posted keys, and the last 100 events: initializes (with the client's name), posts (and how many waits they woke), waits starting (and whether the client sent a progress token), waits ending (`message`, `timeout` or `client_gone`, with duration), deletes and expiry sweeps.

[research/long-waits.md](research/long-waits.md) lists what to check there after the first deploy.

## Development

```bash
mise run setup   # install tools and packages
mise run ci      # lint, type-check and run the tests in workerd
mise run dev     # run locally with test tokens: testsecret and testpost
mise run smoke   # in a second terminal: end-to-end test against mise run dev
```

The design decisions are in [docs/design.md](docs/design.md).

## Cost

The Workers free plan includes 100,000 requests a day and 13,000 GB-s of Durable Object run time a day. While at least one wait is open the object is awake and billed as 128 MB, so the free run time covers about 29 hours of waiting a day, shared by all waits running at once. If you go over, calls fail until the daily reset; there's no bill unless you move to the $5/month paid plan.

## License

[MIT](LICENSE)
