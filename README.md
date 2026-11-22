# DO Drop

A dead drop for AI sessions: post from anywhere, and the waiting session gets it.

DO Drop is a small remote MCP server. A Claude session picks a key and calls `wait` on it. A web page, phone shortcut, webhook or another session posts a JSON payload to that key, and the waiting call returns it, in the same session that asked.

```text
session ──wait(key)──────────────▶ DO Drop   (held open; progress ping every 60 s)
page    ──POST /drop, Bearer key─▶ DO Drop   (no sign-in: the key is the secret)
DO Drop ──payload────────────────▶ session   (the waiting call returns)
```

It runs as one Cloudflare Worker and one SQLite-backed Durable Object ("DO" Drop). Every wait shares that one object, so run-time billing doesn't multiply with the number of waiting sessions.

## How access works

- **The MCP server needs sign-in.** Claude connects with OAuth, and you approve it once with the owner password. Only signed-in clients can wait, read, post or delete.
- **A key is the shared secret.** The session chooses a key (make it long and random), and using it opens the drop. Then the session gives the key to whatever will answer. That side posts with the key as a bearer token, needs no account, and can only post to that one key.
- **Unopened keys don't exist.** Posting to a key no signed-in session has used gets `404`, so nobody can make up keys or fill up storage.

## Tools

Each key holds an append-only list of messages. Every message gets a sequence number (`seq`) that is higher than any before it.

| Tool                                        | What it does                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wait(key, afterSeq=0, timeoutMinutes=360)` | Blocks until `key` has a message with a `seq` greater than `afterSeq`, then returns the oldest one with its `seq` and how many more are `pending`. Returns at once if one is already there, `{"status":"timeout"}` if time runs out (max 720 minutes), and `{"status":"deleted"}` if the key is deleted meanwhile. |
| `post(key, payload)`                        | Appends any JSON value (up to 200 KB), wakes every call waiting on the key, and returns `{seq, woke}`.                                                                                                                                                                                                             |
| `get(key, afterSeq?)`                       | Doesn't wait. Without `afterSeq`, returns the latest message; with it, the messages after it, oldest first, up to 50.                                                                                                                                                                                              |
| `delete(key)`                               | Deletes the key and its messages, and closes it to public posts.                                                                                                                                                                                                                                                   |

Any of these opens the key. For a one-shot answer, call `wait(key)`. For a conversation, pass the last `seq` you saw as `afterSeq`, so nothing posted between calls is missed.

A message looks like `{"seq": 7, "payload": {...}, "postedAt": "2026-11-22T17:00:00.000Z"}`. A key keeps its newest 100 messages and is deleted after 14 days without a wait, get or post. Keys are 1 to 200 letters, digits or `. _ ~ : @ + -`.

## Posting from outside

```bash
curl -X POST "https://do-drop.<you>.workers.dev/drop" \
  -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
  -d '{"done": true}'
```

A JSON body is stored as JSON; anything else is stored as a string. The response is `{"seq", "woke"}`, or `404` if the key isn't open. The endpoint allows cross-origin requests, so a web page can post with `fetch`.

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

3. Set the owner password. Generate one with `openssl rand -hex 24` (or use a passphrase from your password manager), save it, and paste it when Wrangler asks. If Wrangler offers to create the Worker, say yes.

   ```bash
   pnpm exec wrangler secret put OWNER_PASSWORD
   ```

4. Deploy. Wrangler creates the `OAUTH_KV` namespace on the first deploy and prints the Worker's URL, `https://do-drop.<you>.workers.dev`. If your account has no `workers.dev` subdomain yet, it asks you to pick one.

   ```bash
   mise run deploy
   ```

To change the password, run `secret put` again; it applies without a redeploy. Clients that already signed in keep their tokens until they expire.

## Continuous deployment

Every merge to `main` deploys. The Push to Main workflow runs CI, then a `deploy` job in the `production` environment runs `mise run deploy`. `OWNER_PASSWORD` stays in Cloudflare; a deploy doesn't change it.

To set it up:

1. In the Cloudflare dashboard, go to **My Profile**, then **API Tokens**, then **Create Token**, and use the **Edit Cloudflare Workers** template. Limit it to your account and save the token in your password manager.
2. Copy your account ID from the Workers & Pages overview page.
3. In the GitHub repo, go to **Settings**, then **Environments**, and create an environment named `production`. Add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Optionally, add yourself as a required reviewer to approve each deploy, and limit the environment to the `main` branch.

You still set `OWNER_PASSWORD` once, with `wrangler secret put` (step 3 of [Deploy](#deploy)) or in the Cloudflare dashboard under the Worker's **Settings**, **Variables and Secrets**, as a **Secret**. After that, merging is deploying.

## Connect it to Claude

claude.ai, then Settings, Connectors, **Add custom connector**:

- **Name:** DO Drop
- **URL:** `https://do-drop.<you>.workers.dev/mcp`

claude.ai opens DO Drop's sign-in page. Check that the app name and destination look right, enter the owner password, and choose **Allow**.

For Claude Code, add it, then run `/mcp` in a session to sign in the same way:

```bash
claude mcp add --transport http do-drop https://do-drop.<you>.workers.dev/mcp
```

After 10 wrong passwords in 15 minutes, sign-in stops accepting attempts until the 15 minutes are up.

## Debugging

`https://do-drop.<you>.workers.dev/debug` asks for a password in the browser: enter the owner password (any user name). It shows the calls waiting right now, the 100 most recently used keys, and the last 100 events: initializes (with the client's name), posts (and how many waits they woke), waits starting (and whether the client sent a progress token), waits ending (`message`, `timeout`, `deleted` or `client_gone`, with duration), deletes, expiry sweeps and failed sign-ins.

[research/long-waits.md](research/long-waits.md) lists what to check there after the first deploy.

## Development

```bash
mise run setup   # install tools and packages
mise run ci      # lint, type-check and run the tests in workerd
mise run dev     # run locally at https://localhost:8787, owner password: testpassword
```

The tests run the whole flow in workerd, including OAuth sign-in. The design decisions are in [docs/design.md](docs/design.md).

## Cost

The Workers free plan includes 100,000 requests a day, 13,000 GB-s of Durable Object run time a day, and enough KV for the OAuth tokens. While at least one wait is open the object is awake and billed as 128 MB, so the free run time covers about 29 hours of waiting a day, shared by all waits running at once. If you go over, calls fail until the daily reset; there's no bill unless you move to the $5/month paid plan.

## License

[MIT](LICENSE)
