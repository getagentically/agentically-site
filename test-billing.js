/* Local harness for the Sept-25 fixes: webhook provisioning, desktop gate, caps, rate limit. Not shipped. */
const assert = require("assert");
const fs = require("fs"); const os = require("os"); const path = require("path"); const crypto = require("crypto");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ag-b-"));
process.env.DATA_DIR = DATA; process.env.ADMIN_KEY = "adminkey123"; process.env.PORT = "3997";
process.env.PUBLIC_URL = "http://localhost:3997"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.PRICE_SOLO = "price_solo"; process.env.PRICE_TEAM = "price_team"; process.env.PRICE_HQ = "price_hq"; process.env.PRICE_DESKTOP = "price_desk";
global.fetch = async (url) => { throw new Error("no network in test: " + url); };
require("./server.js");
const realFetch = require("http");
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = realFetch.request({ host: "127.0.0.1", port: 3997, path: p, method, headers }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, text: d }); }); });
    if (body) r.write(body); r.end();
  });
}
function signed(obj, tsOffset = 0) {
  const raw = JSON.stringify(obj); const t = Math.floor(Date.now() / 1000) + tsOffset;
  const v1 = crypto.createHmac("sha256", "whsec_test").update(t + "." + raw).digest("hex");
  return { raw, sig: "t=" + t + ",v1=" + v1 };
}
const state = () => JSON.parse(fs.readFileSync(path.join(DATA, "workspace.json"), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(600);
  // 1. checkout.session.completed provisions a SOLO workspace (idempotent)
  let s = signed({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", status: "complete", customer: "cus_1", subscription: "sub_1", metadata: { plan: "solo" }, customer_details: { email: "a@b.co" } } } });
  let r = await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw });
  assert.equal(r.status, 200); await sleep(150);
  r = await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw }); await sleep(150);
  let ws = Object.values(state().workspaces).filter(w => w.plan === "solo");
  assert.equal(ws.length, 1, "exactly one solo workspace after duplicate webhook"); assert.equal(ws[0].email, "a@b.co"); assert.equal(ws[0].stripeSubscription, "sub_1");
  assert.ok(!("_id" in ws[0]), "underscore fields not persisted");
  console.log("webhook provisioning + idempotency OK");
  // 2. replayed (old) signature rejected
  s = signed({ type: "checkout.session.completed", data: { object: { id: "cs_old" } } }, -900);
  r = await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw });
  assert.equal(r.status, 400); console.log("replay rejected OK");
  // 3. desktop key is NOT a cloud workspace
  s = signed({ type: "checkout.session.completed", data: { object: { id: "cs_2", payment_status: "paid", status: "complete", customer: null, metadata: { plan: "desktop" }, customer_details: { email: "d@b.co" } } } });
  await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw }); await sleep(150);
  const dk = Object.values(state().workspaces).find(w => w.plan === "desktop").key;
  r = await req("GET", "/api/state", { headers: { "x-workspace-key": dk } });
  assert.equal(r.status, 402); assert.equal(r.body.error, "desktop_license"); console.log("desktop gate OK");
  // 4. founder is unmetered, solo shows 100
  r = await req("GET", "/api/state", { headers: { "x-workspace-key": "adminkey123" } }); assert.equal(r.body.dailyLimit, null);
  r = await req("GET", "/api/state", { headers: { "x-workspace-key": ws[0].key } }); assert.equal(r.body.dailyLimit, 100); console.log("caps OK");
  // 5. payment_failed pauses writes, invoice.paid restores
  s = signed({ type: "invoice.payment_failed", data: { object: { subscription: "sub_1", customer: "cus_1" } } });
  await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw }); await sleep(150);
  r = await req("POST", "/api/facts", { headers: { "x-workspace-key": ws[0].key, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(r.status, 402); assert.equal(r.body.error, "past_due");
  s = signed({ type: "invoice.paid", data: { object: { subscription: "sub_1", customer: "cus_1" } } });
  await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw }); await sleep(150);
  r = await req("POST", "/api/facts", { headers: { "x-workspace-key": ws[0].key, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(r.status, 200); console.log("past_due / recovery OK");
  // 6. subscription.updated to HQ price changes the plan
  s = signed({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_hq" } }] } } } });
  await req("POST", "/stripe/webhook", { headers: { "content-type": "application/json", "stripe-signature": s.sig }, body: s.raw }); await sleep(150);
  r = await req("GET", "/api/state", { headers: { "x-workspace-key": ws[0].key } }); assert.equal(r.body.plan, "hq"); assert.equal(r.body.seats, 10); console.log("plan change OK");
  // 7. bad facts index is a 404, not a deletion
  r = await req("DELETE", "/api/facts/abc", { headers: { "x-workspace-key": ws[0].key } }); assert.equal(r.status, 404);
  // 8. rate limit
  let last = 200; for (let i = 0; i < 130; i++) { const x = await req("GET", "/api/state", { headers: { "x-workspace-key": ws[0].key } }); last = x.status; if (last === 429) break; }
  assert.equal(last, 429); console.log("rate limit OK");
  // 9. download locked to desktop keys
  r = await req("GET", "/download/desktop?key=" + ws[0].key); assert.equal(r.status, 403);
  r = await req("GET", "/download/desktop?key=" + dk); assert.equal(r.status, 302); console.log("download gate OK");
  // 10. archived operators leave the roster and free the seat
  const admin = { "x-workspace-key": "adminkey123", "content-type": "application/json" };
  r = await req("POST", "/api/operators", { headers: admin, body: JSON.stringify({ name: "Zed", role: "Analyst", lane: "x" }) }); const zid = r.body.operator.id;
  r = await req("PATCH", "/api/operators/" + zid, { headers: admin, body: JSON.stringify({ archived: true }) }); assert.equal(r.status, 200);
  r = await req("GET", "/api/state", { headers: admin }); assert.ok(!r.body.operators.some(o => o.id === zid)); console.log("archived OK");
  console.log("ALL PASS"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
