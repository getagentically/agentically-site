/* Browser test: a message sent to operator A survives switching to operator B mid-turn. Not shipped. */
const fs = require("fs"); const os = require("os"); const path = require("path"); const http = require("http");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ag-sw-"));
process.env.DATA_DIR = DATA; process.env.ADMIN_KEY = "adminkey123"; process.env.ANTHROPIC_API_KEY = "sk-test"; process.env.PORT = "3996";
process.env.PUBLIC_URL = "http://localhost:3996";
// mock Anthropic: 2.5s slow reply that echoes the last user message
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes("api.anthropic.com")) {
    const body = JSON.parse(opts.body); const last = body.messages[body.messages.length - 1];
    const txt = typeof last.content === "string" ? last.content : "(tools)";
    await new Promise(r => setTimeout(r, 2500));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Echo: " + txt }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opts);
};
require("./server.js");
const { chromium } = require("playwright");
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const b = await chromium.launch(); const page = await b.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto("http://127.0.0.1:3996/app");
  await page.fill("#gateKey", "adminkey123"); await page.click("text=Open HQ");
  await page.waitForTimeout(500);
  // hire two operators via API (faster than the modal)
  const hdr = { "x-workspace-key": "adminkey123", "content-type": "application/json" };
  for (const n of ["Alpha", "Bravo"]) await page.evaluate(async ({ n, hdr }) => { await fetch("/api/operators", { method: "POST", headers: hdr, body: JSON.stringify({ name: n, role: "Analyst", lane: "test" }) }); }, { n, hdr });
  await page.reload(); await page.waitForTimeout(600);
  await page.click("text=Alpha"); await page.waitForTimeout(200);
  await page.fill("#inp", "hello alpha"); await page.press("#inp", "Enter");
  await page.waitForTimeout(300);
  // switch to Bravo while Alpha is working, type a draft there, send Bravo a message too
  await page.click("text=Bravo"); await page.waitForTimeout(200);
  await page.fill("#inp", "hello bravo"); await page.press("#inp", "Enter");
  await page.waitForTimeout(300);
  await page.fill("#inp", "unsent draft for bravo");
  // back to Alpha before either reply lands: the pending message and a working bubble must be visible
  await page.click("text=Alpha"); await page.waitForTimeout(500);
  let txt = await page.textContent("#msgs");
  if (!txt.includes("hello alpha")) throw new Error("pending message lost when switching: " + txt);
  if (!txt.includes("working")) throw new Error("no working bubble for pending turn");
  // wait for replies
  await page.waitForTimeout(3500);
  txt = await page.textContent("#msgs");
  if (!txt.includes("Echo: hello alpha")) throw new Error("Alpha reply missing: " + txt);
  await page.click("text=Bravo"); await page.waitForTimeout(500);
  txt = await page.textContent("#msgs");
  if (!txt.includes("hello bravo") || !txt.includes("Echo: hello bravo")) throw new Error("Bravo thread wrong: " + txt);
  const draft = await page.inputValue("#inp");
  if (draft !== "unsent draft for bravo") throw new Error("draft lost: '" + draft + "'");
  // functions for voice exist and Escape doesn't throw
  const hasVoice = await page.evaluate(() => typeof startListening === "function" && typeof stopListening === "function" && typeof floorMic === "function");
  if (!hasVoice) throw new Error("voice functions missing");
  await page.keyboard.press("Escape");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  console.log("SWITCH TEST PASS"); await b.close(); process.exit(0);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
