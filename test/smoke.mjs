// Smoke test against a running relay.
//   RELAY_URL=http://localhost:8787/<SECRET>/mcp node test/smoke.mjs
// Opens a wait, submits from a second request after a delay, and checks
// that the wait returns the answers with progress pings in between.
const URL_ = process.env.RELAY_URL || "http://localhost:8787/testsecret/mcp";
const DELAY_MS = Number(process.env.SUBMIT_AFTER_MS || 12000);
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let nextId = 1;
const rpc = async (method, params) => {
  const r = await fetch(URL_, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  return r.json();
};
const ok = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok -", msg); };

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
ok(init.result?.protocolVersion === "2025-06-18", "initialize negotiates 2025-06-18");
const note = await fetch(URL_, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
ok(note.status === 202, "notification gets 202");
const list = await rpc("tools/list", {});
ok(list.result?.tools?.map((t) => t.name).join() === "wait_for_answers,get_answers,submit_answers", "tools/list has 3 tools");

const setId = "smoke-" + Date.now();
const before = await rpc("tools/call", { name: "get_answers", arguments: { setId } });
ok(before.result?.structuredContent?.status === "not_submitted", "get_answers before submit = not_submitted");
const bad = await rpc("tools/call", { name: "get_answers", arguments: { setId: "bad id!" } });
ok(bad.result?.isError === true, "bad setId is a tool error");

// Open the wait.
const t0 = Date.now();
const waitRes = await fetch(URL_, {
  method: "POST", headers: H,
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "wait_for_answers", arguments: { setId, maxWaitMinutes: 5 }, _meta: { progressToken: "tok-1" } } }),
});
ok(waitRes.headers.get("content-type")?.startsWith("text/event-stream"), "wait responds as an SSE stream");

// Submit from a second connection after a delay.
setTimeout(async () => {
  const s = await rpc("tools/call", { name: "submit_answers", arguments: { setId, answers: { status: "submitted", answers: { q1: { value: "yes" } }, generalNote: "hi" } } });
  console.log("   submit ->", JSON.stringify(s.result?.structuredContent));
}, DELAY_MS);

// Read the stream.
const reader = waitRes.body.getReader();
const dec = new TextDecoder();
let buf = "", progress = 0, final = null;
while (!final) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (!data) continue;
    const m = JSON.parse(data);
    if (m.method === "notifications/progress") { progress++; console.log(`   progress #${m.params.progress} at ${((Date.now() - t0) / 1000).toFixed(1)}s: ${m.params.message} (token ${m.params.progressToken})`); }
    else if (m.id === 99) final = m;
  }
}
ok(progress >= 1, `got ${progress} progress ping(s) while waiting`);
ok(final?.result?.structuredContent?.status === "submitted", "wait returned status submitted");
ok(final.result.structuredContent.answers?.q1?.value === "yes", "wait returned the submitted answers");
console.log(`   wait returned after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const again = await rpc("tools/call", { name: "wait_for_answers", arguments: { setId } });
ok(again.result?.structuredContent?.status === "submitted", "waiting on an already-submitted set returns at once");
const dbg = await (await fetch(URL_.replace(/\/mcp$/, "/debug"))).json();
ok(Array.isArray(dbg.log) && dbg.log.some((e) => e.ev === "wait_end" && e.outcome === "answered"), "debug log recorded the answered wait");
const wrong = await fetch(URL_.replace(/\/[^/]+\/mcp$/, "/wrongsecret/mcp"), { method: "POST", headers: H, body: "{}" });
ok(wrong.status === 404, "wrong secret gets 404");
console.log("\nALL PASSED");
