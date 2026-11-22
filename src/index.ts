/**
 * Questionnaire Relay — a tiny remote MCP server that lets a Claude session
 * block until Jason submits a Questionnaire set, and get the answers back in
 * that same session.
 *
 *   session ──wait_for_answers(setId)──▶ relay   (held open, progress pings)
 *   page    ──submit_answers(setId, …)──▶ relay   (wakes the waiting call)
 *   relay   ──answers────────────────────▶ session
 *
 * One Worker, one SQLite-backed Durable Object ("main") that holds every
 * waiting call and every submitted answer set. MCP is spoken directly over
 * the Streamable HTTP transport (JSON responses, SSE for the long wait).
 * Auth is a secret path segment: https://<host>/<SECRET>/mcp
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  SECRET: string;
  PING_SECONDS?: string;
}

const SERVER_INFO = { name: "questionnaire-relay", version: "0.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SET_ID = /^[A-Za-z0-9._~:@+-]{1,200}$/;
const MAX_ANSWERS_BYTES = 200_000;
const DEFAULT_WAIT_MIN = 360;
const MAX_WAIT_MIN = 720;
const LOG_KEEP = 300;

/* ------------------------------------------------------------------ */
/* Worker entry: check the secret, hand everything to the one DO.      */
/* ------------------------------------------------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const [secret, route, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!env.SECRET || !secret || !safeEqual(secret, env.SECRET) || rest.length) {
      return new Response("Not found", { status: 404 });
    }
    if (route !== "mcp" && route !== "debug") return new Response("Not found", { status: 404 });
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: "wait_for_answers",
    title: "Wait for Questionnaire answers",
    description:
      "Block until Jason submits the Questionnaire set `setId`, then return his answers. " +
      "Post the set to the Questionnaire artifact first. The call stays open and sends progress " +
      "pings while it waits. If `maxWaitMinutes` passes first it returns status \"waiting\"; " +
      "call it again to keep waiting. Returns immediately if the set was already submitted.",
    inputSchema: {
      type: "object",
      properties: {
        setId: { type: "string", description: "The Questionnaire set id, e.g. 2026-11-23-groom-backlog" },
        maxWaitMinutes: {
          type: "number",
          minimum: 1,
          maximum: MAX_WAIT_MIN,
          description: `How long to wait before giving up for now (default ${DEFAULT_WAIT_MIN}).`,
        },
      },
      required: ["setId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_answers",
    title: "Get Questionnaire answers",
    description:
      "Return the submitted answers for `setId` without waiting: status \"submitted\" with the answers, or \"not_submitted\".",
    inputSchema: {
      type: "object",
      properties: { setId: { type: "string" } },
      required: ["setId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "submit_answers",
    title: "Submit Questionnaire answers",
    description:
      "Used by the Questionnaire page when Jason presses Submit. Stores the answers and wakes any session waiting on `setId`. " +
      "Sessions should not call this.",
    inputSchema: {
      type: "object",
      properties: {
        setId: { type: "string" },
        answers: { type: "object", description: "The page's answers document for this set." },
      },
      required: ["setId", "answers"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/* ------------------------------------------------------------------ */
/* The Durable Object                                                  */
/* ------------------------------------------------------------------ */
type Json = Record<string, unknown>;
type RpcMsg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

export class Relay extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Map<string, Set<(row: Stored) => void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS answers (
      set_id TEXT PRIMARY KEY, body TEXT NOT NULL, submitted_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL)`);
  }

  async fetch(req: Request): Promise<Response> {
    const route = new URL(req.url).pathname.split("/").filter(Boolean)[1];
    if (route === "debug") return this.debug();
    if (req.method === "GET") return new Response("This server does not open a GET stream.", { status: 405, headers: { Allow: "POST, DELETE" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let msg: unknown;
    try {
      msg = await req.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(msg)) {
      // Batches (2025-03-26 only). Answer each request; no streaming in a batch.
      const out = [];
      for (const m of msg) {
        const r = await this.handle(m as RpcMsg, req, false);
        if (r && !(r instanceof Response)) out.push(r);
      }
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const r = await this.handle(msg as RpcMsg, req, true);
    if (r instanceof Response) return r;
    if (r === null) return new Response(null, { status: 202 });
    return json(r);
  }

  /** Returns a JSON-RPC response object, a streaming Response, or null for notifications. */
  private async handle(m: RpcMsg, req: Request, canStream: boolean): Promise<Json | Response | null> {
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      return m && "id" in m ? rpcError(m.id ?? null, -32600, "Invalid request") : null;
    }
    const isNotification = !("id" in m) || m.id === undefined;
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
    const id = m.id ?? null;
    const p = (m.params ?? {}) as Json;

    switch (m.method) {
      case "initialize": {
        const asked = String(p.protocolVersion ?? "");
        const protocolVersion = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
        this.log({ ev: "initialize", asked, protocolVersion, client: p.clientInfo, ua: req.headers.get("user-agent") });
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Relay for Jason's Questionnaire artifact. After posting a question set to the artifact, call " +
            "wait_for_answers with its setId to block until he submits.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return this.callTool(id, p, canStream);
      default:
        return rpcError(id, -32601, `Method not found: ${m.method}`);
    }
  }

  private async callTool(id: RpcMsg["id"], p: Json, canStream: boolean): Promise<Json | Response> {
    const name = String(p.name ?? "");
    const args = (p.arguments ?? {}) as Json;
    const meta = (p._meta ?? {}) as Json;
    const progressToken = meta.progressToken as string | number | undefined;
    const setId = String(args.setId ?? "");
    if (!SET_ID.test(setId)) return toolError(id, "setId must be 1-200 letters, digits or . _ ~ : @ + -");

    if (name === "get_answers") {
      const row = this.read(setId);
      return rpcResult(id, toolResult(row ? submittedPayload(row) : { status: "not_submitted", setId }));
    }

    if (name === "submit_answers") {
      const answers = args.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return toolError(id, "answers must be an object");
      const body = JSON.stringify(answers);
      if (body.length > MAX_ANSWERS_BYTES) return toolError(id, "answers too large");
      const submittedAt = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO answers (set_id, body, submitted_at) VALUES (?, ?, ?)
         ON CONFLICT(set_id) DO UPDATE SET body = excluded.body, submitted_at = excluded.submitted_at`,
        setId, body, submittedAt,
      );
      const row: Stored = { setId, body, submittedAt };
      const waiting = this.waiters.get(setId);
      const woke = waiting ? waiting.size : 0;
      waiting?.forEach((fn) => fn(row));
      this.log({ ev: "submit", setId, woke });
      return rpcResult(id, toolResult({ status: "stored", setId, deliveredToWaitingSessions: woke }));
    }

    if (name === "wait_for_answers") {
      const minutes = clamp(Number(args.maxWaitMinutes ?? DEFAULT_WAIT_MIN), 1, MAX_WAIT_MIN);
      const existing = this.read(setId);
      this.log({ ev: "wait_start", setId, minutes, progressToken: progressToken ?? null, already: !!existing });
      if (existing) return rpcResult(id, toolResult(submittedPayload(existing)));
      if (!canStream) return toolError(id, "wait_for_answers can't run inside a JSON-RPC batch");
      return this.streamWait(id, setId, minutes, progressToken);
    }

    return toolError(id, `Unknown tool: ${name}`);
  }

  /** Hold the call open as an SSE stream: progress pings until answers arrive or time runs out. */
  private streamWait(id: RpcMsg["id"], setId: string, minutes: number, progressToken?: string | number): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = (obj: unknown) => w.write(enc.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
    const pingMs = clamp(Number(this.env.PING_SECONDS ?? 60), 5, 240) * 1000;
    const started = Date.now();
    const deadline = started + minutes * 60_000;

    const run = async () => {
      let n = 0;
      let outcome = "unknown";
      try {
        while (true) {
          const left = deadline - Date.now();
          if (left <= 0) {
            outcome = "timeout";
            await send(rpcResult(id, toolResult({
              status: "waiting", setId,
              message: `No answers after ${minutes} minutes. Call wait_for_answers again to keep waiting, or get_answers later.`,
            })));
            break;
          }
          const row = await this.waitOnce(setId, Math.min(pingMs, left));
          if (row) {
            outcome = "answered";
            await send(rpcResult(id, toolResult(submittedPayload(row))));
            break;
          }
          n++;
          const waited = Math.round((Date.now() - started) / 60_000);
          if (progressToken !== undefined) {
            await send({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken, progress: n, message: `Waiting for Jason's answers (${waited} min)` },
            });
          } else {
            await w.write(enc.encode(`: still waiting ${waited} min\n\n`));
          }
        }
      } catch (e) {
        outcome = "client_gone";
      } finally {
        this.log({ ev: "wait_end", setId, outcome, pings: n, minutes: Math.round((Date.now() - started) / 6_000) / 10 });
        try { await w.close(); } catch { /* already closed */ }
      }
    };
    this.ctx.waitUntil(run());

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
    });
  }

  private waitOnce(setId: string, ms: number): Promise<Stored | null> {
    return new Promise((resolve) => {
      let set = this.waiters.get(setId);
      if (!set) this.waiters.set(setId, (set = new Set()));
      const done = (row: Stored | null) => {
        clearTimeout(timer);
        set!.delete(fn);
        if (!set!.size) this.waiters.delete(setId);
        resolve(row);
      };
      const fn = (row: Stored) => done(row);
      const timer = setTimeout(() => done(null), ms);
      set.add(fn);
    });
  }

  private read(setId: string): Stored | null {
    const r = this.sql.exec<{ body: string; submitted_at: string }>(
      "SELECT body, submitted_at FROM answers WHERE set_id = ?", setId,
    ).toArray()[0];
    return r ? { setId, body: r.body, submittedAt: r.submitted_at } : null;
  }

  private log(event: Json) {
    try {
      this.sql.exec("INSERT INTO log (ts, event) VALUES (?, ?)", new Date().toISOString(), JSON.stringify(event));
      this.sql.exec("DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - ?", LOG_KEEP);
    } catch { /* logging must never break a call */ }
  }

  private debug(): Response {
    const rows = this.sql.exec<{ ts: string; event: string }>("SELECT ts, event FROM log ORDER BY id DESC LIMIT 100").toArray();
    const waiting = [...this.waiters.entries()].map(([setId, s]) => ({ setId, calls: s.size }));
    return json({ waiting, log: rows.map((r) => ({ ts: r.ts, ...JSON.parse(r.event) })) });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
type Stored = { setId: string; body: string; submittedAt: string };

function submittedPayload(row: Stored): Json {
  let doc: Json = {};
  try { doc = JSON.parse(row.body); } catch { /* keep empty */ }
  return {
    status: "submitted",
    setId: row.setId,
    submittedAt: row.submittedAt,
    answers: doc.answers ?? {},
    generalNote: doc.generalNote ?? "",
  };
}
function toolResult(payload: Json): Json {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
function toolError(id: RpcMsg["id"], message: string): Json {
  return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
}
function rpcResult(id: RpcMsg["id"], result: unknown): Json {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: RpcMsg["id"], code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi;
}
