import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EXPIRY_MS, MAX_MESSAGES_PER_KEY, MAX_PAYLOAD_BYTES } from "../src/limits";

const BASE = "https://drop.test";
const MCP = `${BASE}/testsecret/mcp`;
const REST = `${BASE}/testpost/post`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let nextId = 1;
type Rpc = { id?: number; result?: any; error?: any; method?: string; params?: any };

function send(body: unknown, url = MCP) {
  return SELF.fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
}
async function rpc(method: string, params: unknown = {}): Promise<Rpc> {
  return (await send({ jsonrpc: "2.0", id: nextId++, method, params })).json();
}
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result;
}
const sc = async (name: string, args: Record<string, unknown>) => (await call(name, args)).structuredContent;

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
    const bad = await SELF.fetch(MCP, { method: "POST", headers: H, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("returns tool errors for bad keys, bad afterSeq and unknown tools", async () => {
    expect((await call("get", { key: "bad key!" })).isError).toBe(true);
    expect((await call("get", { key: "a".repeat(201) })).isError).toBe(true);
    expect((await call("get", { key: "k", afterSeq: -1 })).isError).toBe(true);
    expect((await call("frob", { key: "k" })).isError).toBe(true);
  });
});

describe("auth", () => {
  it("hides everything behind the right token", async () => {
    expect((await send({}, `${BASE}/wrong/mcp`)).status).toBe(404);
    expect((await send({}, `${BASE}/testsecret/other`)).status).toBe(404);
    expect((await send({}, `${BASE}/testsecret/mcp/extra`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/`)).status).toBe(404);
  });

  it("keeps the post token post-only", async () => {
    expect((await send({}, `${BASE}/testpost/mcp`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/testpost/debug`)).status).toBe(404);
    expect((await SELF.fetch(`${REST}/k`)).status).toBe(405);
  });

  it("does not accept the MCP secret on the post endpoint", async () => {
    const r = await SELF.fetch(`${BASE}/testsecret/post/k`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
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

  it("deletes a key, and never reuses its seqs", async () => {
    const first = await sc("post", { key: "del", payload: 1 });
    await sc("post", { key: "del", payload: 2 });
    expect(await sc("delete", { key: "del" })).toMatchObject({ status: "deleted", messages: 2 });
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
    const { id, res } = waitCall({ key: "block", timeoutMinutes: 1 }, "tok");
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
    const { id, res } = waitCall({ key: "after", afterSeq: old.seq, timeoutMinutes: 1 });
    const pending = res.then(readSse);
    await sleep(300);
    const fresh = await sc("post", { key: "after", payload: "new" });
    const final = (await pending).find((m) => m.id === id);
    expect(final?.result.structuredContent).toMatchObject({ seq: fresh.seq, payload: "new" });
  });

  it("wakes from the REST endpoint", async () => {
    const { id, res } = waitCall({ key: "phone", timeoutMinutes: 1 });
    const pending = res.then(readSse);
    await sleep(300);
    const r = await SELF.fetch(`${REST}/phone`, { method: "POST", body: JSON.stringify({ from: "shortcut" }) });
    expect(await r.json()).toMatchObject({ key: "phone", woke: 1 });
    const final = (await pending).find((m) => m.id === id);
    expect(final?.result.structuredContent.payload).toEqual({ from: "shortcut" });
  });
});

describe("REST post", () => {
  it("stores JSON as JSON and anything else as a string", async () => {
    await SELF.fetch(`${REST}/rest`, { method: "POST", body: '{"a":1}' });
    await SELF.fetch(`${REST}/rest`, { method: "POST", body: "hello" });
    const all = await sc("get", { key: "rest", afterSeq: 0 });
    expect(all.messages.map((m: { payload: unknown }) => m.payload)).toEqual([{ a: 1 }, "hello"]);
  });

  it("decodes the key and validates it", async () => {
    await SELF.fetch(`${REST}/a%3Ab`, { method: "POST", body: "1" });
    expect((await sc("get", { key: "a:b" })).messages[0].payload).toBe(1);
    expect((await SELF.fetch(`${REST}/bad%20key`, { method: "POST", body: "1" })).status).toBe(400);
  });

  it("caps payload size", async () => {
    const r = await SELF.fetch(`${REST}/big`, { method: "POST", body: "x".repeat(MAX_PAYLOAD_BYTES + 1) });
    expect(r.status).toBe(413);
  });
});

describe("expiry", () => {
  it("deletes keys idle for 14 days and keeps the rest", async () => {
    await sc("post", { key: "stale", payload: 1 });
    await sc("post", { key: "fresh", payload: 2 });
    const stub = env.DROP.get(env.DROP.idFromName("main"));
    await runInDurableObject(stub, async (_drop, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec("UPDATE messages SET posted_at = ? WHERE key = 'stale'", Date.now() - EXPIRY_MS - 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await sc("get", { key: "stale" })).status).toBe("empty");
    expect((await sc("get", { key: "fresh" })).status).toBe("ok");
    await runInDurableObject(stub, async (_drop, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("debug", () => {
  it("shows keys and events", async () => {
    await sc("post", { key: "dbg", payload: 1 });
    const d: any = await (await SELF.fetch(`${BASE}/testsecret/debug`)).json();
    expect(d.keys.some((k: { key: string }) => k.key === "dbg")).toBe(true);
    expect(d.log.some((e: { ev: string }) => e.ev === "post")).toBe(true);
  });
});

describe("entry module", () => {
  it("exports only handlers, or workerd refuses to start it", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod).sort()).toEqual(["Drop", "default"]);
  });
});
