import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EXPIRY_MS,
  MAX_MESSAGES_PER_KEY,
  MAX_PAYLOAD_BYTES,
  MAX_WAIT_SECONDS,
  SIGN_IN_MAX_FAILURES,
} from "../src/limits";
import { BASE, REDIRECT, signIn, startSignIn, submit } from "./oauth";

const MCP = `${BASE}/mcp`;
const DROP = `${BASE}/drop`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let token = "";
beforeEach(async () => {
  token = await signIn();
});

let nextId = 1;
type Rpc = { id?: number; result?: any; error?: any; method?: string; params?: any };

function send(body: unknown, bearer: string | null = token) {
  const headers: Record<string, string> = { ...H };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return SELF.fetch(MCP, { method: "POST", headers, body: JSON.stringify(body) });
}
async function rpc(method: string, params: unknown = {}): Promise<Rpc> {
  return (await send({ jsonrpc: "2.0", id: nextId++, method, params })).json();
}
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result;
}
const sc = async (name: string, args: Record<string, unknown>) => (await call(name, args)).structuredContent;

/** Post to a key the way a page, phone or webhook would. */
function drop(key: string, body: string, init: RequestInit = {}) {
  return SELF.fetch(DROP, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, ...init });
}

/** Read an SSE response to the end; returns the JSON-RPC messages it carried. */
async function readSse(res: Response): Promise<Rpc[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join(""),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}
function waitCall(args: Record<string, unknown>, progressToken?: string) {
  const id = nextId++;
  const params = { name: "wait", arguments: args, ...(progressToken ? { _meta: { progressToken } } : {}) };
  return { id, res: send({ jsonrpc: "2.0", id, method: "tools/call", params }) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sign-in", () => {
  it("challenges unauthenticated MCP calls and publishes OAuth metadata", async () => {
    const r = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    const bad = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-a-token");
    expect(bad.status).toBe(401);

    const prm: any = await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(MCP);
    const as: any = await (await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
  });

  it("shows the client and where access goes, escaped, and can't be framed", async () => {
    const s = await startSignIn();
    expect(s.html).toContain("Test &#60;client&#62;");
    expect(s.html).toContain("client.test");
    expect(s.html).not.toContain("<client>");
    const framing = `${s.page.headers.get("X-Frame-Options")} ${s.page.headers.get("Content-Security-Policy")}`;
    expect(framing).toMatch(/DENY|frame-ancestors 'none'/);
  });

  it("refuses a wrong password, then accepts the right one on the same page", async () => {
    const s = await startSignIn();
    const wrong = await submit(s, "nope");
    expect(wrong.status).toBe(403);
    const right = await submit(s, "testpassword");
    expect(right.status).toBe(302);
    expect(right.headers.get("Location")).toMatch(new RegExp(`^${REDIRECT}\\?.*code=`));
  });

  it("sends Deny back to the client as access_denied", async () => {
    const r = await submit(await startSignIn(), "", "deny");
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("Location") ?? "").searchParams.get("error")).toBe("access_denied");
  });

  it(`locks after ${SIGN_IN_MAX_FAILURES} wrong passwords, even for the right one`, async () => {
    // Storage is shared across tests, so start and end with no recorded failures.
    const stub = env.DROP.get(env.DROP.idFromName("main"));
    const reset = () =>
      runInDurableObject(stub, async (_drop, state) => {
        state.storage.sql.exec("DELETE FROM sign_in_failures");
      });
    await reset();
    try {
      const s = await startSignIn();
      for (let i = 0; i < SIGN_IN_MAX_FAILURES; i++) expect((await submit(s, `wrong-${i}`)).status).toBe(403);
      expect((await submit(s, "testpassword")).status).toBe(429);
      const basic = await SELF.fetch(`${BASE}/debug`, {
        headers: { Authorization: `Basic ${btoa("me:testpassword")}` },
      });
      expect(basic.status).toBe(429);
    } finally {
      await reset();
    }
  });

  it("puts /debug behind the owner password", async () => {
    expect((await SELF.fetch(`${BASE}/debug`)).status).toBe(401);
    const wrong = await SELF.fetch(`${BASE}/debug`, { headers: { Authorization: `Basic ${btoa("me:nope")}` } });
    expect(wrong.status).toBe(401);
    await sc("post", { key: "dbg", payload: 1 });
    const d: any = await (
      await SELF.fetch(`${BASE}/debug`, { headers: { Authorization: `Basic ${btoa("me:testpassword")}` } })
    ).json();
    expect(d.keys.some((k: { key: string }) => k.key === "dbg")).toBe(true);
    expect(d.log.some((e: { ev: string }) => e.ev === "post")).toBe(true);
  });
});

describe("MCP protocol", () => {
  it("initializes, accepts notifications and lists the four tools", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t" },
    });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("do-drop");
    const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["wait", "post", "get", "delete"]);
  });

  it("falls back to the newest protocol it knows", async () => {
    const init = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(init.result.protocolVersion).toBe("2025-11-25");
  });

  it("rejects unknown methods and bad JSON", async () => {
    expect((await rpc("nope")).error.code).toBe(-32601);
    const bad = await SELF.fetch(MCP, {
      method: "POST",
      headers: { ...H, Authorization: `Bearer ${token}` },
      body: "{",
    });
    expect(bad.status).toBe(400);
  });

  it("returns tool errors for bad keys, bad afterSeq and unknown tools", async () => {
    expect((await call("get", { key: "bad key!" })).isError).toBe(true);
    expect((await call("get", { key: "a".repeat(201) })).isError).toBe(true);
    expect((await call("get", { key: "k", afterSeq: -1 })).isError).toBe(true);
    expect((await call("frob", { key: "k" })).isError).toBe(true);
  });
});

describe("post, get and delete", () => {
  it("appends with increasing seqs and reads them back", async () => {
    expect(await sc("get", { key: "pgd" })).toMatchObject({ status: "empty", messages: [] });
    const a = await sc("post", { key: "pgd", payload: { n: 1 } });
    const b = await sc("post", { key: "pgd", payload: "two" });
    const c = await sc("post", { key: "pgd", payload: [3] });
    expect(a).toMatchObject({ status: "posted", key: "pgd", woke: 0 });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.seq).toBeGreaterThan(b.seq);

    const latest = await sc("get", { key: "pgd" });
    expect(latest.messages).toHaveLength(1);
    expect(latest.messages[0]).toMatchObject({ seq: c.seq, payload: [3] });
    expect(latest.messages[0].postedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const all = await sc("get", { key: "pgd", afterSeq: 0 });
    expect(all.messages.map((m: { payload: unknown }) => m.payload)).toEqual([{ n: 1 }, "two", [3]]);
    const tail = await sc("get", { key: "pgd", afterSeq: a.seq });
    expect(tail.messages.map((m: { seq: number }) => m.seq)).toEqual([b.seq, c.seq]);
    expect(tail.more).toBe(0);
  });

  it("keeps keys apart", async () => {
    await sc("post", { key: "one", payload: 1 });
    await sc("post", { key: "two", payload: 2 });
    expect((await sc("get", { key: "one", afterSeq: 0 })).messages).toHaveLength(1);
  });

  it("deletes a key, closes it to public posts, and never reuses its seqs", async () => {
    const first = await sc("post", { key: "del", payload: 1 });
    await sc("post", { key: "del", payload: 2 });
    expect(await sc("delete", { key: "del" })).toMatchObject({ status: "deleted", messages: 2 });
    expect((await drop("del", "x")).status).toBe(404);
    expect((await sc("get", { key: "del" })).status).toBe("empty");
    const again = await sc("post", { key: "del", payload: 3 });
    expect(again.seq).toBeGreaterThan(first.seq + 1);
  });

  it("caps payload size", async () => {
    const r = await call("post", { key: "big", payload: "x".repeat(MAX_PAYLOAD_BYTES) });
    expect(r.isError).toBe(true);
    expect((await call("post", { key: "big" })).isError).toBe(true);
  });

  it(`keeps only the newest ${MAX_MESSAGES_PER_KEY} messages per key`, async () => {
    let last = 0;
    for (let i = 0; i < MAX_MESSAGES_PER_KEY + 5; i++) last = (await sc("post", { key: "cap", payload: i })).seq;
    const page1 = await sc("get", { key: "cap", afterSeq: 0 });
    expect(page1.messages[0].payload).toBe(5);
    expect(page1.messages).toHaveLength(50);
    expect(page1.more).toBe(MAX_MESSAGES_PER_KEY - 50);
    expect((await sc("get", { key: "cap" })).messages[0].seq).toBe(last);
  });
});

describe("wait", () => {
  it("returns at once when a message is already there", async () => {
    const a = await sc("post", { key: "ready", payload: "a" });
    const b = await sc("post", { key: "ready", payload: "b" });
    const r = await call("wait", { key: "ready" });
    expect(r.structuredContent).toMatchObject({ status: "message", seq: a.seq, payload: "a", pending: 1 });
    const r2 = await sc("wait", { key: "ready", afterSeq: a.seq });
    expect(r2).toMatchObject({ seq: b.seq, payload: "b", pending: 0 });
  });

  it("blocks, sends progress pings, and returns what gets posted", async () => {
    const { id, res } = waitCall({ key: "block", timeoutSeconds: 60 }, "tok");
    const pending = res.then(async (r) => {
      expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
      return readSse(r);
    });
    await sleep(2500);
    const posted = await sc("post", { key: "block", payload: { answer: 42 } });
    expect(posted.woke).toBe(1);

    const msgs = await pending;
    const pings = msgs.filter((m) => m.method === "notifications/progress");
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0].params.progressToken).toBe("tok");
    const final = msgs.find((m) => m.id === id);
    expect(final?.result.structuredContent).toMatchObject({
      status: "message",
      seq: posted.seq,
      payload: { answer: 42 },
    });
  });

  it("ignores messages at or before afterSeq", async () => {
    const old = await sc("post", { key: "after", payload: "old" });
    const { id, res } = waitCall({ key: "after", afterSeq: old.seq, timeoutSeconds: 60 });
    const pending = res.then(readSse);
    await sleep(300);
    const fresh = await sc("post", { key: "after", payload: "new" });
    const final = (await pending).find((m) => m.id === id);
    expect(final?.result.structuredContent).toMatchObject({ seq: fresh.seq, payload: "new" });
  });

  it("wakes from a public post", async () => {
    const { id, res } = waitCall({ key: "phone-7f3a9c", timeoutSeconds: 60 });
    const pending = res.then(readSse);
    await sleep(300);
    const r = await drop("phone-7f3a9c", JSON.stringify({ from: "shortcut" }));
    expect(await r.json()).toMatchObject({ woke: 1 });
    const final = (await pending).find((m) => m.id === id);
    expect(final?.result.structuredContent.payload).toEqual({ from: "shortcut" });
  });

  it("ends the wait on the server when the client hangs up", async () => {
    const abort = new AbortController();
    const id = nextId++;
    const res = SELF.fetch(MCP, {
      method: "POST",
      headers: { ...H, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "wait", arguments: { key: "hangup", timeoutSeconds: 60 } },
      }),
      signal: abort.signal,
    });
    await (await res).body?.getReader().read(); // the stream is open
    abort.abort();
    await sleep(300);
    // Nobody is waiting any more, so a post wakes no one and the log records the hang-up.
    expect((await sc("post", { key: "hangup", payload: 1 })).woke).toBe(0);
    const d: any = await (
      await SELF.fetch(`${BASE}/debug`, { headers: { Authorization: `Basic ${btoa("me:testpassword")}` } })
    ).json();
    const end = d.log.find((e: { ev: string; key: string }) => e.ev === "wait_end" && e.key === "hangup");
    expect(end?.outcome).toBe("client_gone");
  });

  it("times out with status timeout, and a later wait still gets what was posted meanwhile", async () => {
    const { id, res } = waitCall({ key: "late", timeoutSeconds: 2 });
    const final = (await res.then(readSse)).find((m) => m.id === id);
    expect(final?.result.structuredContent).toMatchObject({ status: "timeout", key: "late", afterSeq: 0 });
    await drop("late", '"answered while nobody waited"');
    expect(await sc("wait", { key: "late", timeoutSeconds: 2 })).toMatchObject({
      status: "message",
      payload: "answered while nobody waited",
    });
  });

  it("rejects the old timeoutMinutes argument and caps timeoutSeconds", async () => {
    expect((await call("wait", { key: "old", timeoutMinutes: 1 })).isError).toBe(true);
    const list = await rpc("tools/list");
    const wait = list.result.tools.find((t: { name: string }) => t.name === "wait");
    expect(wait.inputSchema.properties.timeoutSeconds.maximum).toBe(MAX_WAIT_SECONDS);
  });

  it("logs cancellations from clients that give up", async () => {
    const note = await send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 42, reason: "timeout" },
    });
    expect(note.status).toBe(202);
    const d: any = await (
      await SELF.fetch(`${BASE}/debug`, { headers: { Authorization: `Basic ${btoa("me:testpassword")}` } })
    ).json();
    expect(d.log.find((e: { ev: string }) => e.ev === "cancelled")).toMatchObject({ requestId: 42, reason: "timeout" });
  });

  it("returns deleted when the key is deleted while waiting", async () => {
    const { id, res } = waitCall({ key: "gone", timeoutSeconds: 60 });
    const pending = res.then(readSse);
    await sleep(300);
    await sc("delete", { key: "gone" });
    const final = (await pending).find((m) => m.id === id);
    expect(final?.result.structuredContent).toEqual({ status: "deleted", key: "gone" });
  });
});

describe("public post", () => {
  it("only accepts keys the owner has opened", async () => {
    expect((await drop("never-opened", "1")).status).toBe(404);
    await sc("get", { key: "opened" });
    expect((await drop("opened", "1")).status).toBe(200);
  });

  it("needs the key as a bearer token", async () => {
    await sc("get", { key: "hdr" });
    expect((await SELF.fetch(DROP, { method: "POST", body: "1" })).status).toBe(404);
    const basic = await SELF.fetch(DROP, { method: "POST", headers: { Authorization: "Basic aGRy" }, body: "1" });
    expect(basic.status).toBe(404);
    expect((await drop("bad key!", "1")).status).toBe(404);
    expect((await SELF.fetch(DROP)).status).toBe(405);
  });

  it("stores JSON as JSON and anything else as a string", async () => {
    await sc("get", { key: "pub" });
    await drop("pub", '{"a":1}');
    await drop("pub", "hello");
    const all = await sc("get", { key: "pub", afterSeq: 0 });
    expect(all.messages.map((m: { payload: unknown }) => m.payload)).toEqual([{ a: 1 }, "hello"]);
  });

  it("caps payload size", async () => {
    await sc("get", { key: "big" });
    expect((await drop("big", "x".repeat(MAX_PAYLOAD_BYTES + 1))).status).toBe(413);
  });

  it("allows cross-origin posts from pages", async () => {
    const pre = await SELF.fetch(DROP, {
      method: "OPTIONS",
      headers: { Origin: "https://page.test", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
    await sc("get", { key: "cors" });
    expect((await drop("cors", "1")).headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("expiry", () => {
  it("deletes keys unused for 14 days and keeps the rest", async () => {
    await sc("post", { key: "stale", payload: 1 });
    await sc("post", { key: "fresh", payload: 2 });
    const stub = env.DROP.get(env.DROP.idFromName("main"));
    await runInDurableObject(stub, async (_drop, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec("UPDATE keys SET touched_at = ? WHERE key = 'stale'", Date.now() - EXPIRY_MS - 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await drop("stale", "1")).status).toBe(404);
    expect((await drop("fresh", "1")).status).toBe(200);
    await runInDurableObject(stub, async (_drop, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("entry module", () => {
  it("exports only handlers, or workerd refuses to start it", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod).sort()).toEqual(["Drop", "default"]);
  });
});
