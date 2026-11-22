import { SELF } from "cloudflare:test";

export const BASE = "https://drop.test";
export const REDIRECT = "https://client.test/callback";

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Register a client and open the authorize page, the way claude.ai does. */
export async function startSignIn() {
  const reg = await SELF.fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      client_name: "Test <client>",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const page = await SELF.fetch(`${BASE}/authorize?${query}`);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { clientId, verifier, query, page, html, handle, cookie };
}

/** Submit the authorize form. */
export function submit(
  s: Awaited<ReturnType<typeof startSignIn>>,
  password: string,
  decision: "approve" | "deny" = "approve",
) {
  return SELF.fetch(`${BASE}/authorize?${s.query}`, {
    method: "POST",
    headers: { Cookie: s.cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ handle: s.handle, password, decision }),
    redirect: "manual",
  });
}

/** The whole flow: returns an access token for /mcp. */
export async function signIn(): Promise<string> {
  const s = await startSignIn();
  const res = await submit(s, "testpassword");
  const code = new URL(res.headers.get("Location") ?? "").searchParams.get("code");
  if (!code) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const token = await SELF.fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: s.clientId,
      code_verifier: s.verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}
