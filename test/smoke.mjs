// End-to-end smoke test against a running DO Drop, local or deployed.
//
//   mise run dev     # in one terminal
//   mise run smoke   # in another
//
// Against a deployment, set DROP_URL, DROP_SECRET and DROP_POST_TOKEN. The test
// opens a wait, posts to it through the REST endpoint after POST_AFTER_MS, and
// checks that the wait returns the payload. Progress pings are checked when
// the wait is held longer than the ping interval: by default locally
// (PING_SECONDS=5), or remotely with POST_AFTER_MS=75000. It deletes its key
// at the end.
const BASE = (process.env.DROP_URL || "http://localhost:8787").replace(/\/+$/, "");
const SECRET = process.env.DROP_SECRET || "testsecret";
const POST_TOKEN = process.env.DROP_POST_TOKEN || "testpost";
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
const DELAY_MS = Number(process.env.POST_AFTER_MS || 12000);
const EXPECT_PINGS = DELAY_MS >= (LOCAL ? 6000 : 65000);

const MCP = `${BASE}/${SECRET}/mcp`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let nextId = 1;
const rpc = async (method, params) => {
  const r = await fetch(MCP, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return r.json();
};
const tool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok -", msg);
};

console.log(`DO Drop smoke test against ${BASE}`);
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
ok(init.result?.protocolVersion === "2025-06-18", "initialize negotiates 2025-06-18");
const note = await fetch(MCP, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
ok(note.status === 202, "notification gets 202");
const list = await rpc("tools/list", {});
ok(list.result?.tools?.map((t) => t.name).join() === "wait,post,get,delete", "tools/list has wait, post, get, delete");

const key = "smoke-" + Date.now();
ok((await tool("get", { key })).structuredContent?.status === "empty", "get on a new key is empty");
ok((await tool("get", { key: "bad key!" })).isError === true, "a bad key is a tool error");

// Open the wait.
const t0 = Date.now();
const waitRes = await fetch(MCP, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name: "wait", arguments: { key, timeoutMinutes: 5 }, _meta: { progressToken: "tok-1" } },
  }),
});
ok(waitRes.headers.get("content-type")?.startsWith("text/event-stream"), "wait responds as an SSE stream");

// Post through the REST endpoint after a delay, the way a phone or webhook would.
setTimeout(async () => {
  const r = await fetch(`${BASE}/${POST_TOKEN}/post/${encodeURIComponent(key)}`, {
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
  });
  console.log(`   REST post -> ${r.status} ${await r.text()}`);
}, DELAY_MS);

// Read the stream.
const reader = waitRes.body.getReader();
const dec = new TextDecoder();
let buf = "";
let progress = 0;
let final = null;
while (!final) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const chunk = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = chunk
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("");
    if (!data) continue;
    const m = JSON.parse(data);
    if (m.method === "notifications/progress") {
      progress++;
      const at = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`   progress #${m.params.progress} at ${at}s: ${m.params.message} (token ${m.params.progressToken})`);
    } else if (m.id === 99) final = m;
  }
}
if (EXPECT_PINGS) ok(progress >= 1, `got ${progress} progress ping(s) while waiting`);
else console.log(`   ${progress} progress ping(s); set POST_AFTER_MS=75000 to require one`);
const got = final?.result?.structuredContent;
ok(got?.status === "message", "wait returned a message");
ok(got.payload?.hello === "world", "wait returned the posted payload");
console.log(`   wait returned after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const second = (await tool("post", { key, payload: "second" })).structuredContent;
ok(second?.seq > got.seq, "an MCP post gets a higher seq");
const next = (await tool("wait", { key, afterSeq: got.seq })).structuredContent;
ok(next?.payload === "second", "wait with afterSeq returns the next message at once");
const all = (await tool("get", { key, afterSeq: 0 })).structuredContent;
ok(all?.messages?.length === 2, "get with afterSeq=0 lists both messages");

const dbg = await (await fetch(`${BASE}/${SECRET}/debug`)).json();
ok(
  Array.isArray(dbg.log) && dbg.log.some((e) => e.ev === "wait_end" && e.key === key && e.outcome === "message"),
  "debug log recorded the wait ending with a message",
);
const wrong = await fetch(`${BASE}/wrongsecret/mcp`, { method: "POST", headers: H, body: "{}" });
ok(wrong.status === 404, "a wrong secret gets 404");
const postOnly = await fetch(`${BASE}/${POST_TOKEN}/mcp`, { method: "POST", headers: H, body: "{}" });
ok(postOnly.status === 404, "the post token can't reach the MCP endpoint");

ok((await tool("delete", { key })).structuredContent?.messages === 2, "delete removed the test key");
console.log("\nALL PASSED");
