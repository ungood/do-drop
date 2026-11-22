/**
 * Owner sign-in: the OAuth authorize page (for MCP clients such as claude.ai)
 * and HTTP Basic auth (for /debug in a browser). Both check OWNER_PASSWORD,
 * and both stop accepting attempts after too many recent failures.
 */
import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Drop } from "./index";

export interface AuthEnv {
  DROP: DurableObjectNamespace<Drop>;
  OWNER_PASSWORD?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Shown when sign-in is locked after too many failures. */
const LOCKED = "Too many failed sign-ins. Try again in 15 minutes.";

/** Check the owner password, counting failures against the lockout. */
export async function checkPassword(env: AuthEnv, password: string): Promise<"ok" | "wrong" | "locked"> {
  const drop = env.DROP.get(env.DROP.idFromName("main"));
  if (!(await drop.signInAllowed())) return "locked";
  if (env.OWNER_PASSWORD && (await sameSecret(password, env.OWNER_PASSWORD))) return "ok";
  await drop.signInFailed();
  return "wrong";
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** HTTP Basic auth with the owner password (any user name). Returns a 401 or 429 Response, or null if signed in. */
export async function requireBasicAuth(req: Request, env: AuthEnv): Promise<Response | null> {
  const header = req.headers.get("Authorization") ?? "";
  const challenge = new Response("Sign in with the owner password.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="DO Drop", charset="UTF-8"' },
  });
  if (!header.startsWith("Basic ")) return challenge;
  let password: string;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    password = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return challenge;
  }
  const result = await checkPassword(env, password);
  if (result === "ok") return null;
  if (result === "locked") return new Response(LOCKED, { status: 429 });
  return challenge;
}

/** GET shows the sign-in and consent page; POST checks the password and completes the authorization. */
export async function authorize(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(page(details, consent.handle), { headers: consent.headers });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const result = await checkPassword(env, String(form.get("password") ?? ""));
    if (result !== "ok") {
      // The handle stays unused, so the browser's back button gets another try.
      const message = result === "locked" ? LOCKED : "Wrong password. Go back and try again.";
      return text(message, result === "locked" ? 429 : 403);
    }
    const approved = await oauth.approveConsent(req, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: {},
      scope: approved.request.scope,
      props: { owner: true },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return text(error.description ?? "This sign-in request isn't valid.", 400);
    if (error instanceof CimdFetchError) return text("This app could not be verified.", 400);
    throw error;
  }
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to DO Drop</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
  input[type=password] { width: 100%; padding: .5rem; font: inherit; box-sizing: border-box; }
  button { padding: .5rem 1rem; font: inherit; margin-right: .5rem; }
</style>
<h1>Allow ${name} to use DO Drop?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><label>Owner password<br><input type="password" name="password" autocomplete="current-password" autofocus></label></p>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>
</html>`;
}
