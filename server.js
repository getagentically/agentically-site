const express = require("express");
const fs = require("fs");
const path = require("path");

/* ===== operator runtime ===== */
// Agentically — operator runtime. Real Claude API calls with approval-gated tools.
const MODEL = process.env.AGENTICALLY_MODEL || "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";

const TOOLS = [
  {
    name: "submit_for_approval",
    description:
      "Submit a finished deliverable to the owner's approvals inbox. You MUST use this for anything that would be published, posted, sent, spent, or shipped — never claim something was sent or posted yourself. The owner reviews the exact content and approves or rejects it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. '3 social posts for this week'" },
        summary: { type: "string", description: "One line on what this is and what happens when approved" },
        content: { type: "string", description: "The exact final deliverable, ready to ship as-is" }
      },
      required: ["title", "summary", "content"]
    }
  },
  {
    name: "remember_fact",
    description:
      "Save a durable fact about the owner's business to shared memory (products, prices, audience, preferences, constraints). Use when you learn something worth remembering across conversations. Never invent facts.",
    input_schema: {
      type: "object",
      properties: { fact: { type: "string", description: "The fact, stated plainly" } },
      required: ["fact"]
    }
  }
];

function systemPrompt(op, facts) {
  const factLines = facts.length
    ? facts.map(f => "- " + f.text).join("\n")
    : "- (nothing recorded yet — ask the owner rather than assuming)";
  return `You are ${op.name}, an AI operator working for the owner of this business inside Agentically.

YOUR ROLE: ${op.role}
YOUR LANE (what you own): ${op.lane}
STANDING ORDERS FROM THE OWNER: ${op.orders || "(none set)"}

WHAT YOU KNOW ABOUT THE BUSINESS:
${factLines}

HOW YOU WORK — these rules are absolute:
1. You are an operator, not a chatbot. You take a goal, do the thinking, and come back with finished work — not a list of things the owner could do.
2. THE APPROVAL GATE: nothing you produce goes live on its own. Any deliverable that would be published, posted, sent, spent, or shipped MUST be submitted with the submit_for_approval tool, containing the exact final content. Never say you posted, sent, scheduled, or spent anything — you cannot, and claiming otherwise is a serious failure.
3. NEVER FABRICATE. No invented statistics, prices, reviews, follower counts, or sources. A number is either sourced or clearly labeled an estimate with the assumption stated. If you don't know something about the business, ask.
4. Stay in your lane. If a request belongs to a different operator's role, say so and suggest which operator should handle it.
5. Be concise and direct. The owner reads on a phone. Lead with the answer.
6. Use remember_fact when you learn something durable about the business.`;
}

async function callClaude({ apiKey, messages, system, maxTokens = 2000 }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, tools: TOOLS, messages })
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error("anthropic_error");
    err.status = res.status;
    err.detail = body.slice(0, 500);
    throw err;
  }
  return res.json();
}

// Runs one turn, resolving tool calls (max 4 hops), returns {text, approvals[], facts[]}
async function runOperator({ apiKey, operator, facts, userText, onApproval, onFact }) {
  const system = systemPrompt(operator, facts);
  const history = (operator.messages || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
  const messages = [...history, { role: "user", content: userText }];

  const producedApprovals = [];
  const producedFacts = [];
  let finalText = "";

  for (let hop = 0; hop < 4; hop++) {
    const data = await callClaude({ apiKey, messages, system });
    const textParts = data.content.filter(c => c.type === "text").map(c => c.text);
    if (textParts.length) finalText = textParts.join("\n").trim();

    const toolUses = data.content.filter(c => c.type === "tool_use");
    if (!toolUses.length) break;

    messages.push({ role: "assistant", content: data.content });
    const results = [];
    for (const t of toolUses) {
      if (t.name === "submit_for_approval") {
        const item = onApproval(t.input);
        producedApprovals.push(item);
        results.push({
          type: "tool_result",
          tool_use_id: t.id,
          content: "Queued in the owner's approvals inbox as item " + item.id + ". It is NOT live until the owner approves it."
        });
      } else if (t.name === "remember_fact") {
        onFact(t.input.fact);
        producedFacts.push(t.input.fact);
        results.push({ type: "tool_result", tool_use_id: t.id, content: "Saved to business memory." });
      } else {
        results.push({ type: "tool_result", tool_use_id: t.id, content: "Unknown tool.", is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (!finalText && producedApprovals.length) {
    finalText = "Done — queued " + producedApprovals.length + " item(s) in your approvals inbox for review.";
  }
  return { text: finalText || "(no response)", approvals: producedApprovals, facts: producedFacts };
}



/* ===== multi-tenant store ===== */
// Agentically multi-tenant store. Each customer gets an isolated workspace.
// Persists to DATA_DIR/workspace.json (Railway volume). Migrates the legacy single-workspace shape.

const S_DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const FILE = path.join(S_DATA_DIR, "workspace.json");
fs.mkdirSync(S_DATA_DIR, { recursive: true });

const BLANK_WS = () => ({
  key: "", plan: "solo", planStatus: "active", email: "", stripeCustomer: "", createdAt: new Date().toISOString(),
  operators: [], approvals: [], facts: [], schedules: [], activity: [], usage: {}
});

function freshState() { return { v: 2, workspaces: {}, sessions: [] }; }

function load() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { return freshState(); }
  if (raw && raw.v === 2 && raw.workspaces) return raw;
  // migrate legacy single-workspace shape (operators at top level) into the founder workspace
  const st = freshState();
  if (raw && Array.isArray(raw.operators)) {
    const ws = BLANK_WS();
    ws.key = process.env.ADMIN_KEY || "";
    ws.plan = "founder";
    ws.operators = raw.operators || [];
    ws.approvals = raw.approvals || [];
    ws.facts = raw.facts || [];
    ws.schedules = raw.schedules || [];
    ws.activity = raw.activity || [];
    st.workspaces["founder"] = ws;
  }
  return st;
}

let state = load();
// ensure the founder workspace always exists and follows ADMIN_KEY
(function ensureFounder() {
  const ak = process.env.ADMIN_KEY || "";
  if (!ak) return;
  if (!state.workspaces["founder"]) { state.workspaces["founder"] = Object.assign(BLANK_WS(), { key: ak, plan: "founder" }); }
  state.workspaces["founder"].key = ak;
  state.workspaces["founder"].plan = "founder";
})();

let writeTimer = null;
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error("save failed", e.message); }
  }, 60);
}

const id = p => p + "_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();
const newKey = () => require("crypto").randomBytes(18).toString("hex");

const STORE = {
  state: () => state,
  save, id, now,
  byKey(key) {
    if (!key) return null;
    for (const [wid, ws] of Object.entries(state.workspaces)) if (ws.key === key) return Object.assign(ws, { _id: wid });
    return null;
  },
  createWorkspace({ plan, email, stripeCustomer, sessionId }) {
    const wid = id("ws");
    const ws = BLANK_WS();
    ws.key = newKey();
    ws.plan = plan; ws.email = email || ""; ws.stripeCustomer = stripeCustomer || "";
    state.workspaces[wid] = ws;
    if (sessionId) state.sessions.push(sessionId);
    this.log(ws, "System", "workspace created on the " + plan.toUpperCase() + " plan");
    save();
    return Object.assign(ws, { _id: wid });
  },
  sessionUsed: sid => state.sessions.includes(sid),
  sessionWorkspace(sid) { // re-show welcome page on refresh
    for (const [wid, ws] of Object.entries(state.workspaces)) if (ws.sessionId === sid) return ws;
    return null;
  },
  byCustomer(cust) {
    for (const ws of Object.values(state.workspaces)) if (cust && ws.stripeCustomer === cust) return ws;
    return null;
  },
  log(ws, who, what) {
    ws.activity.unshift({ ts: now(), who, what });
    ws.activity = ws.activity.slice(0, 200);
    save();
  },
  addOperator(ws, o) {
    const op = { id: id("op"), name: o.name, role: o.role, lane: o.lane, orders: o.orders || "", createdAt: now(), messages: [] };
    ws.operators.push(op);
    this.log(ws, op.name, "hired as " + op.role + " operator");
    return op;
  },
  deleteOperator(ws, opId) {
    const op = ws.operators.find(o => o.id === opId);
    ws.operators = ws.operators.filter(o => o.id !== opId);
    ws.schedules = ws.schedules.filter(s => s.operatorId !== opId);
    if (op) this.log(ws, op.name, "removed from the roster");
    return !!op;
  },
  addApproval(ws, a) {
    const item = { id: id("ap"), operatorId: a.operatorId, operatorName: a.operatorName, title: a.title, summary: a.summary, content: a.content, status: "pending", createdAt: now() };
    ws.approvals.unshift(item);
    this.log(ws, a.operatorName, 'queued "' + a.title + '" for approval');
    return item;
  },
  resolveApproval(ws, apId, approved) {
    const item = ws.approvals.find(a => a.id === apId);
    if (!item) return null;
    item.status = approved ? "approved" : "rejected";
    item.resolvedAt = now();
    this.log(ws, "You", (approved ? "approved" : "rejected") + ' "' + item.title + '"');
    return item;
  },
  addFact(ws, text) {
    if (!text || ws.facts.some(f => f.text === text)) return null;
    ws.facts.push({ text, ts: now() });
    save();
  },
  addSchedule(ws, s) {
    const sch = { id: id("sch"), operatorId: s.operatorId, hour: Math.max(0, Math.min(23, parseInt(s.hour, 10) || 9)), minute: Math.max(0, Math.min(59, parseInt(s.minute, 10) || 0)), prompt: s.prompt, lastRunKey: null, createdAt: now() };
    ws.schedules.push(sch);
    save();
    return sch;
  },
  deleteSchedule(ws, schId) {
    const before = ws.schedules.length;
    ws.schedules = ws.schedules.filter(s => s.id !== schId);
    save();
    return ws.schedules.length < before;
  },
  // per-day message counter for usage caps
  bumpUsage(ws) {
    const day = new Date().toISOString().slice(0, 10);
    ws.usage = ws.usage || {};
    ws.usage[day] = (ws.usage[day] || 0) + 1;
    for (const k of Object.keys(ws.usage)) if (k !== day) delete ws.usage[k];
    save();
    return ws.usage[day];
  },
  usageToday(ws) {
    const day = new Date().toISOString().slice(0, 10);
    return (ws.usage && ws.usage[day]) || 0;
  }
};

/* ===== legal ===== */
function legalPage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Agentically</title><style>body{background:#06080d;color:#dbe4ee;font-family:Inter,system-ui,sans-serif;line-height:1.7;margin:0}.w{max-width:680px;margin:0 auto;padding:28px 20px 80px}a{color:#5aa2ff;text-decoration:none}.logo{font-weight:800;color:#fff}.logo span{color:#37e0c8}h1{color:#fff;font-size:26px}h2{color:#fff;font-size:17px;margin-top:26px}p,li{font-size:14.5px;color:#b9c6d4}pre{white-space:pre-wrap}</style></head><body><div class="w"><a href="/" class="logo">agentic<span>ally</span></a><h1>${title}</h1>${body}</div></body></html>`;
}

const TERMS = `
<p>Effective: September 2026. Agentically is operated by HPM3 LLC ("we", "us"). By purchasing or using Agentically you agree to these terms.</p>
<h2>What Agentically is</h2>
<p>Agentically provides AI "operators" — software agents powered by third-party large language models — that produce drafts, research, and other work product inside your workspace. Operators can be wrong. All output is queued for your review, and you are responsible for anything you approve, publish, or act on. Agentically is not legal, medical, or financial advice.</p>
<h2>Plans and billing</h2>
<p>Cloud plans (Solo, Team, HQ) are monthly subscriptions billed through Stripe and include a fair-use daily allowance of operator activity; you can add your own Anthropic API key at any time for unlimited use at your own API cost. The Desktop License is a one-time purchase of the downloadable software, which runs on your own machine with your own API key. You can cancel a subscription any time; access continues to the end of the paid period. If a payment fails or a subscription is canceled, the workspace is paused, not deleted.</p>
<h2>Your data</h2>
<p>Your workspace (operators, memory, conversations, approvals) belongs to you. We don't sell it and we don't use it to train models. Operator conversations are processed by Anthropic's API under their commercial terms. See the <a href="/privacy">Privacy Policy</a>.</p>
<h2>Acceptable use</h2>
<p>Don't use Agentically for anything unlawful, to generate spam or deceptive content, to violate others' rights, or to probe or disrupt the service. Keep your workspace key secret — anyone holding it can act in your workspace. We may suspend workspaces that break these rules.</p>
<h2>Service and liability</h2>
<p>Agentically is provided "as is" without warranties. To the maximum extent permitted by law, our total liability for any claim is limited to the amount you paid us in the three months before the claim. We may update these terms; material changes will be posted here.</p>
<p>Contact: hello@getagentically.com</p>`;

const PRIVACY = `
<p>Effective: September 2026. This explains what Agentically (HPM3 LLC) collects and why.</p>
<h2>What we collect</h2>
<p><b>Account:</b> the email you use at checkout and your Stripe customer reference. Payments are processed by Stripe — we never see or store card numbers. <b>Workspace content:</b> the operators you create, business facts you save, conversations, approvals, and schedules — stored so the product works, visible only to holders of your workspace key. <b>Waitlist:</b> the email you submit. <b>Basic logs</b> for reliability and abuse prevention.</p>
<h2>How AI processing works</h2>
<p>Operator conversations are sent to Anthropic's API to generate responses, and voice playback may be generated by ElevenLabs. These providers process the content to deliver the feature under their own commercial terms; we do not use your content to train models. Desktop License users' content goes directly from their machine to their own API accounts.</p>
<h2>What we don't do</h2>
<p>We don't sell your data, run ads on it, or share it except with the processors above (Stripe, Anthropic, ElevenLabs, and our host, Railway) as needed to run the service, or if the law requires.</p>
<h2>Your choices</h2>
<p>Email hello@getagentically.com to export or delete your workspace, or to remove yourself from the waitlist. Deleting a workspace is permanent.</p>`;

/* ===== app shell ===== */
const APP_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Agentically HQ</title>\n<meta name=\"robots\" content=\"noindex\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{--bg:#06080d;--panel:#0c1119;--panel2:#101828;--line:#1c2940;--text:#dbe4ee;--dim:#8296ac;\n    --accent:#37e0c8;--accent2:#5aa2ff;--warn:#ffb454;--danger:#ff6b6b;\n    --mono:'JetBrains Mono',ui-monospace,Consolas,monospace;--sans:'Inter',system-ui,-apple-system,sans-serif}\n  *{box-sizing:border-box}\n  html,body{height:100%;margin:0}\n  body{background:var(--bg);color:var(--text);font-family:var(--sans);display:flex;flex-direction:column}\n  button,input,select,textarea{font-family:inherit}\n  button{cursor:pointer}\n  a{color:var(--accent2);text-decoration:none}\n  header{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}\n  .logo{font-weight:800;font-size:17px;color:#fff}.logo span{color:var(--accent)}\n  .chip{font-family:var(--mono);font-size:11px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 12px}\n  .chip.act{color:var(--accent);border-color:rgba(55,224,200,.4)}\n  .chip.warn{color:var(--warn);border-color:rgba(255,180,84,.4)}\n  main{flex:1;display:grid;grid-template-columns:265px 1fr 320px;min-height:0}\n  @media(max-width:980px){main{grid-template-columns:1fr;overflow:auto}.col{border-right:none!important;border-bottom:1px solid var(--line);max-height:none!important}}\n  .col{min-height:0;overflow-y:auto;border-right:1px solid var(--line);padding:14px}\n  .ct{font-family:var(--mono);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);margin:0 0 10px;display:flex;justify-content:space-between;align-items:center}\n  .op{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-bottom:9px;cursor:pointer}\n  .op:hover{border-color:#2a3d5c}\n  .op.on{border-color:var(--accent);background:linear-gradient(90deg,rgba(55,224,200,.07),var(--panel))}\n  .op .nm{font-weight:700;color:#fff;font-size:14px}\n  .op .rl{font-family:var(--mono);font-size:10px;color:var(--accent);margin:2px 0 5px;letter-spacing:.08em}\n  .op .st{font-size:12px;color:var(--dim)}\n  .dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--accent);margin-right:6px}\n  .btn{background:var(--accent);border:none;border-radius:9px;color:#04211c;font-weight:700;padding:9px 16px;font-size:13.5px}\n  .btn.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:500}\n  .btn.ghost:hover{color:var(--accent);border-color:var(--accent)}\n  .btn.dash{width:100%;background:transparent;border:1px dashed var(--line);color:var(--dim);padding:11px;border-radius:11px;font-size:13.5px}\n  .btn.dash:hover{color:var(--accent);border-color:var(--accent)}\n  .chat{display:flex;flex-direction:column;padding:0}\n  .chead{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n  .chead .who{font-weight:700;color:#fff}\n  .chead .lane{font-family:var(--mono);font-size:11px;color:var(--accent)}\n  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;min-height:240px}\n  .msg{max-width:84%;padding:11px 15px;border-radius:14px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}\n  .msg.user{align-self:flex-end;background:var(--panel2);border:1px solid var(--line);border-bottom-right-radius:4px}\n  .msg.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}\n  .msg .tag{font-family:var(--mono);font-size:10px;color:var(--accent);display:block;margin-bottom:5px;letter-spacing:.1em}\n  .msg.sys{align-self:center;background:transparent;border:1px dashed var(--line);color:var(--dim);font-size:12.5px;max-width:92%}\n  .bar{display:flex;gap:8px;padding:13px 15px;border-top:1px solid var(--line)}\n  .bar input{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 15px;color:#fff;font-size:15px}\n  .bar input:focus{outline:none;border-color:var(--accent)}\n  .ico{background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--dim);width:46px;font-size:16px}\n  .ico.on{color:var(--accent);border-color:var(--accent);box-shadow:0 0 14px rgba(55,224,200,.25)}\n  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:9px}\n  .card.ap{border-left:3px solid var(--warn)}\n  .card .t{font-size:13.5px;color:#fff;font-weight:600}\n  .card .d{font-size:12.5px;color:var(--dim);margin:4px 0 8px}\n  .card pre{background:#080d15;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;color:var(--text);white-space:pre-wrap;max-height:190px;overflow:auto;margin:0 0 9px;font-family:var(--mono)}\n  .card button{font-size:12px;border-radius:8px;padding:6px 13px;border:1px solid var(--line);background:transparent;margin-right:6px;color:var(--dim)}\n  .card .ok{color:#04211c;background:var(--accent);border-color:var(--accent);font-weight:700}\n  .card .no{color:var(--danger)}\n  .feed{font-size:12.5px;color:var(--dim);border-left:2px solid var(--line);padding:2px 0 2px 11px;margin-bottom:8px}\n  .feed b{color:var(--text);font-weight:600}\n  .feed .tm{font-family:var(--mono);font-size:10px;color:#54677e;display:block}\n  .fact{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--dim);padding:6px 0;border-bottom:1px solid #141c28}\n  .fact button{background:none;border:none;color:#54677e;font-size:14px;padding:0 4px}\n  .fact button:hover{color:var(--danger)}\n  .modal{position:fixed;inset:0;background:rgba(3,6,10,.8);display:none;align-items:center;justify-content:center;padding:18px;z-index:60}\n  .modal.open{display:flex}\n  .box{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:24px;max-width:460px;width:100%;max-height:88vh;overflow:auto}\n  .box h3{margin:0 0 4px;color:#fff}\n  .box p.s{color:var(--dim);font-size:13.5px;margin:0 0 14px}\n  .box label{font-family:var(--mono);font-size:10.5px;color:var(--dim);letter-spacing:.1em;display:block;margin:12px 0 5px}\n  .box input,.box select,.box textarea{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 13px;color:#fff;font-size:14px}\n  .box textarea{resize:vertical;min-height:58px}\n  .box .row{display:flex;gap:10px;margin-top:19px;justify-content:flex-end}\n  .plan{display:flex;justify-content:space-between;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 15px;cursor:pointer;margin-bottom:9px}\n  .plan:hover,.plan.cur{border-color:var(--accent)}\n  .plan .pn{font-weight:700;color:#fff;font-size:14px}\n  .plan .pd{font-size:12px;color:var(--dim)}\n  .plan .pp{font-family:var(--mono);color:var(--accent);font-size:14px}\n  .empty{color:#54677e;font-size:12.5px;text-align:center;margin:14px 0}\n  .gate{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:80}\n  .gate .box{max-width:380px;text-align:center}\n  .err{color:var(--danger);font-size:12.5px;margin-top:8px;min-height:16px}\n  .thinking{display:inline-block;animation:blink 1.2s infinite}\n  @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}\n</style>\n</head>\n<body>\n\n<div class=\"gate\" id=\"gate\">\n  <div class=\"box\">\n    <h3>agentic<span style=\"color:var(--accent)\">ally</span> HQ</h3>\n    <p class=\"s\">Enter your workspace key to open your command center.</p>\n    <input id=\"gateKey\" type=\"password\" placeholder=\"Workspace key\" onkeydown=\"if(event.key==='Enter')unlock()\">\n    <div class=\"err\" id=\"gateErr\"></div>\n    <div class=\"row\" style=\"justify-content:center\"><button class=\"btn\" onclick=\"unlock()\">Open HQ</button></div>\n  </div>\n</div>\n\n<header>\n  <div class=\"logo\">agentic<span>ally</span> <span style=\"color:var(--dim);font-weight:400;font-size:12px\">HQ</span></div>\n  <span class=\"chip\" id=\"modelChip\">\u2014</span>\n  <span style=\"flex:1\"></span>\n  <button class=\"chip act\" id=\"planChip\" onclick=\"openPlans()\">PLAN</button>\n  <button class=\"chip\" onclick=\"openSettings()\">\u2699 Settings</button>\n</header>\n\n<main>\n  <div class=\"col\">\n    <p class=\"ct\">Operators <span id=\"seats\"></span></p>\n    <div id=\"ops\"></div>\n    <button class=\"btn dash\" onclick=\"tryAdd()\">+ Hire an operator</button>\n    <p class=\"ct\" style=\"margin-top:22px\">Business memory</p>\n    <div id=\"facts\"></div>\n    <button class=\"btn ghost\" style=\"width:100%;margin-top:8px;font-size:12.5px\" onclick=\"addFact()\">+ Add a fact</button>\n  </div>\n\n  <div class=\"col chat\">\n    <div class=\"chead\">\n      <span class=\"dot\"></span><span class=\"who\" id=\"who\">No operator</span><span class=\"lane\" id=\"lane\"></span>\n      <span style=\"flex:1\"></span>\n      <button class=\"ico\" id=\"spk\" title=\"Speak replies\" onclick=\"toggleSpeak()\" style=\"width:auto;padding:7px 11px;font-size:12.5px\">\ud83d\udd0a voice</button>\n      <button class=\"ico\" id=\"schBtn\" title=\"Schedule a run\" onclick=\"openSchedule()\" style=\"width:auto;padding:7px 11px;font-size:12.5px\">\u23f0 schedule</button>\n    </div>\n    <div class=\"msgs\" id=\"msgs\"></div>\n    <div class=\"bar\">\n      <button class=\"ico\" id=\"mic\" title=\"Talk\" onclick=\"toggleMic()\">\ud83c\udf99</button>\n      <input id=\"inp\" placeholder=\"Type or talk to your operator\u2026\" onkeydown=\"if(event.key==='Enter')send()\">\n      <button class=\"btn\" onclick=\"send()\">Send</button>\n    </div>\n  </div>\n\n  <div class=\"col\">\n    <p class=\"ct\">Approvals inbox</p>\n    <div id=\"aps\"></div>\n    <p class=\"empty\" id=\"apsEmpty\">Nothing waiting on you.</p>\n    <p class=\"ct\" style=\"margin-top:22px\">Scheduled runs</p>\n    <div id=\"schs\"></div>\n    <p class=\"ct\" style=\"margin-top:22px\">Activity</p>\n    <div id=\"feed\"></div>\n  </div>\n</main>\n\n<div class=\"modal\" id=\"mAdd\"><div class=\"box\">\n  <h3>Hire an operator</h3>\n  <p class=\"s\">Give it a name, a lane, and standing orders. It shows up every day.</p>\n  <label>NAME</label><input id=\"fName\" placeholder=\"e.g., Maya\">\n  <label>ROLE</label>\n  <select id=\"fRole\"><option>Marketing</option><option>Operations</option><option>Client Services</option><option>Research</option><option>Analyst</option><option>Custom</option></select>\n  <label>LANE \u2014 WHAT IT OWNS</label><input id=\"fLane\" placeholder=\"e.g., content + social for my shop\">\n  <label>STANDING ORDERS</label><textarea id=\"fOrders\" placeholder=\"e.g., Nothing posts without my approval. Always show sources.\"></textarea>\n  <div class=\"err\" id=\"addErr\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mAdd')\">Cancel</button><button class=\"btn\" onclick=\"addOp()\">Hire</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mPlan\"><div class=\"box\">\n  <h3>Your plan</h3>\n  <p class=\"s\">Seats control how many operators you can run.</p>\n  <div id=\"planRows\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mPlan')\">Close</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mSet\"><div class=\"box\">\n  <h3>Settings</h3>\n  <p class=\"s\">Bring your own Anthropic API key to run operators on your own account (desktop / BYO-key mode). Stored only in this browser and sent straight to Anthropic.</p>\n  <label>ANTHROPIC API KEY</label><input id=\"setKey\" type=\"password\" placeholder=\"sk-ant-\u2026\">\n  <p class=\"s\" style=\"margin-top:10px\" id=\"cloudNote\"></p>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"clearKey()\">Clear</button><button class=\"btn\" onclick=\"saveKey()\">Save</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mSch\"><div class=\"box\">\n  <h3>Schedule a run</h3>\n  <p class=\"s\">Your operator runs this on its own each day and queues the result in your approvals inbox.</p>\n  <label>OPERATOR</label><select id=\"sOp\"></select>\n  <label>TIME (UTC, 24H)</label>\n  <div style=\"display:flex;gap:8px\"><input id=\"sH\" type=\"number\" min=\"0\" max=\"23\" value=\"13\" style=\"width:80px\"><input id=\"sM\" type=\"number\" min=\"0\" max=\"59\" value=\"0\" style=\"width:80px\"></div>\n  <label>WHAT SHOULD IT DO?</label><textarea id=\"sPrompt\" placeholder=\"e.g., Draft this week's 3 social posts and queue them for my approval.\"></textarea>\n  <div class=\"err\" id=\"schErr\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mSch')\">Cancel</button><button class=\"btn\" onclick=\"addSchedule()\">Schedule</button></div>\n</div></div>\n\n<script>\nconst SEATS={solo:1,team:3,hq:10};\nconst PLANS={solo:{name:'SOLO',price:'$19/mo',desc:'1 operator'},team:{name:'TEAM',price:'$49/mo',desc:'3 operators + scheduled runs'},hq:{name:'HQ',price:'$99/mo',desc:'10 operators'}};\nlet KEY=localStorage.getItem('ag_key')||'';\nlet BYO=localStorage.getItem('ag_byo')||'';\nlet S={operators:[],approvals:[],facts:[],schedules:[],activity:[],plan:'hq'};\nlet active=null, speak=false, busy=false;\n\nconst esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nfunction hdrs(){const h={'Content-Type':'application/json','x-workspace-key':KEY};if(BYO)h['x-anthropic-key']=BYO;return h}\nasync function api(path,opts={}){const r=await fetch('/api'+path,{...opts,headers:hdrs()});\n  if(r.status===401){localStorage.removeItem('ag_key');location.reload();return}\n  let j={};try{j=await r.json()}catch(e){}\n  if(!r.ok)throw Object.assign(new Error(j.message||j.error||'request failed'),{data:j});return j}\n\nasync function unlock(){\n  const k=document.getElementById('gateKey').value.trim();\n  const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});\n  if(!r.ok){document.getElementById('gateErr').textContent='That key was not accepted.';return}\n  KEY=k;localStorage.setItem('ag_key',k);document.getElementById('gate').style.display='none';boot();\n}\nasync function boot(){\n  try{S=await api('/state')}catch(e){return}\n  document.getElementById('modelChip').textContent=S.model;\n  document.getElementById('cloudNote').textContent=S.cloudKey\n    ?'A workspace key is configured on the server, so operators work without your own key.'\n    :'No server key is set \u2014 add your own key above to run operators.';\n  if(!active&&S.operators.length)active=S.operators[0].id;\n  render();\n  if(active)loadMessages();\n}\nfunction render(){renderOps();renderFacts();renderAps();renderSchs();renderFeed();\n  const pc=document.getElementById('planChip');\n  pc.textContent='PLAN: '+(S.plan||'').toUpperCase()+(S.dailyLimit&&!S.founder?' \u00b7 '+S.usageToday+'/'+S.dailyLimit+' today':'');\n  pc.onclick=S.founder?openPlans:function(){alert('Your plan is managed through billing. Email hello@getagentically.com to change it.')};\n  document.getElementById('seats').textContent=S.local?S.operators.length+' operators':S.operators.length+'/'+(S.seats||1)+' seats';\n  if(S.local){pc.style.display='none'}\n  const op=S.operators.find(o=>o.id===active);\n  document.getElementById('who').textContent=op?op.name:'No operator';\n  document.getElementById('lane').textContent=op?'\u00b7 '+op.role.toUpperCase():'';\n}\nfunction renderOps(){\n  const el=document.getElementById('ops');el.innerHTML='';\n  if(!S.operators.length){el.innerHTML='<p class=\"empty\">No operators yet. Hire your first one below.</p>';return}\n  S.operators.forEach(o=>{const d=document.createElement('div');d.className='op'+(o.id===active?' on':'');\n    d.innerHTML='<div class=\"nm\">'+esc(o.name)+'</div><div class=\"rl\">'+esc(o.role).toUpperCase()+'</div><div class=\"st\"><span class=\"dot\"></span>'+esc(o.lane)+'</div>';\n    d.onclick=()=>{active=o.id;render();loadMessages()};el.appendChild(d)});\n}\nfunction renderFacts(){\n  const el=document.getElementById('facts');el.innerHTML='';\n  if(!S.facts.length){el.innerHTML='<p class=\"empty\">Nothing recorded yet.</p>';return}\n  S.facts.forEach((f,i)=>{const d=document.createElement('div');d.className='fact';\n    d.innerHTML='<span>'+esc(f.text)+'</span>';\n    const b=document.createElement('button');b.textContent='\u00d7';b.onclick=async()=>{await api('/facts/'+i,{method:'DELETE'});boot()};\n    d.appendChild(b);el.appendChild(d)});\n}\nfunction renderAps(){\n  const el=document.getElementById('aps');el.innerHTML='';\n  const pend=S.approvals.filter(a=>a.status==='pending');\n  document.getElementById('apsEmpty').style.display=pend.length?'none':'block';\n  pend.forEach(a=>{const d=document.createElement('div');d.className='card ap';\n    d.innerHTML='<div class=\"t\">'+esc(a.title)+'</div><div class=\"d\">from '+esc(a.operatorName)+' \u2014 '+esc(a.summary)+'</div><pre>'+esc(a.content)+'</pre>';\n    const ok=document.createElement('button');ok.className='ok';ok.textContent='Approve';ok.onclick=()=>resolveAp(a.id,'approve');\n    const no=document.createElement('button');no.className='no';no.textContent='Reject';no.onclick=()=>resolveAp(a.id,'reject');\n    d.appendChild(ok);d.appendChild(no);el.appendChild(d)});\n}\nfunction renderSchs(){\n  const el=document.getElementById('schs');el.innerHTML='';\n  if(!S.schedules.length){el.innerHTML='<p class=\"empty\">No scheduled runs.</p>';return}\n  S.schedules.forEach(s=>{const op=S.operators.find(o=>o.id===s.operatorId);\n    const d=document.createElement('div');d.className='card';\n    d.innerHTML='<div class=\"t\">'+esc(op?op.name:'(removed)')+' \u00b7 '+String(s.hour).padStart(2,'0')+':'+String(s.minute).padStart(2,'0')+' UTC</div><div class=\"d\">'+esc(s.prompt)+'</div>';\n    const run=document.createElement('button');run.textContent='Run now';run.onclick=async()=>{run.textContent='Running\u2026';\n      try{await api('/schedules/'+s.id+'/run',{method:'POST'});await boot()}catch(e){alert(e.message)}};\n    const del=document.createElement('button');del.className='no';del.textContent='Delete';del.onclick=async()=>{await api('/schedules/'+s.id,{method:'DELETE'});boot()};\n    d.appendChild(run);d.appendChild(del);el.appendChild(d)});\n}\nfunction renderFeed(){\n  const el=document.getElementById('feed');el.innerHTML='';\n  S.activity.slice(0,14).forEach(f=>{const d=document.createElement('div');d.className='feed';\n    d.innerHTML='<span class=\"tm\">'+new Date(f.ts).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</span><b>'+esc(f.who)+'</b> '+esc(f.what);\n    el.appendChild(d)});\n}\nasync function loadMessages(){\n  const m=document.getElementById('msgs');m.innerHTML='';\n  if(!active)return;\n  const op=S.operators.find(o=>o.id===active);\n  let msgs=[];try{msgs=(await api('/operators/'+active+'/messages')).messages}catch(e){}\n  if(!msgs.length){\n    const w=document.createElement('div');w.className='msg assistant';\n    w.innerHTML='<span class=\"tag\">'+esc(op.name).toUpperCase()+' \u00b7 '+esc(op.role).toUpperCase()+'</span>'+\n      \"I'm \"+esc(op.name)+\", your \"+esc(op.role.toLowerCase())+\" operator. My lane: \"+esc(op.lane)+\". What do you want handled?\";\n    m.appendChild(w);\n  }\n  msgs.forEach(x=>{const d=document.createElement('div');d.className='msg '+x.role;\n    d.innerHTML=(x.role==='assistant'?'<span class=\"tag\">'+esc(op.name).toUpperCase()+(x.source==='scheduled'?' \u00b7 SCHEDULED':'')+'</span>':'')+esc(x.content);\n    m.appendChild(d)});\n  m.scrollTop=m.scrollHeight;\n}\nasync function send(){\n  if(busy)return;\n  const inp=document.getElementById('inp');const t=inp.value.trim();\n  if(!t)return;\n  if(!active){alert('Hire an operator first.');return}\n  inp.value='';busy=true;\n  const m=document.getElementById('msgs');\n  const u=document.createElement('div');u.className='msg user';u.textContent=t;m.appendChild(u);\n  const think=document.createElement('div');think.className='msg assistant';\n  think.innerHTML='<span class=\"thinking\">working\u2026</span>';m.appendChild(think);m.scrollTop=m.scrollHeight;\n  try{\n    const r=await api('/operators/'+active+'/message',{method:'POST',body:JSON.stringify({text:t})});\n    think.innerHTML='<span class=\"tag\">'+esc(S.operators.find(o=>o.id===active).name).toUpperCase()+'</span>'+esc(r.text);\n    if(speak){await speakText(r.text.slice(0,600))}\n    const st=await api('/state');S=st;renderAps();renderFacts();renderFeed();\n  }catch(e){\n    think.className='msg sys';\n    think.textContent=e.data&&e.data.error==='no_api_key'\n      ? 'No Anthropic API key configured. Open Settings to add your own key, or set one on the server.'\n      : (e.message||'Something went wrong.');\n  }\n  busy=false;m.scrollTop=m.scrollHeight;\n}\nasync function resolveAp(id,action){await api('/approvals/'+id+'/'+action,{method:'POST'});await boot()}\nfunction tryAdd(){\n  if(!S.local&&S.operators.length>=(S.seats||1)){ if(S.founder){openPlans()} else {alert('You are using all '+S.seats+' operator seats on the '+S.plan.toUpperCase()+' plan. Upgrade at getagentically.com/#pricing or email hello@getagentically.com.')} return}\n  document.getElementById('addErr').textContent='';document.getElementById('mAdd').classList.add('open');\n}\nasync function addOp(){\n  const body={name:document.getElementById('fName').value.trim(),role:document.getElementById('fRole').value,\n    lane:document.getElementById('fLane').value.trim(),orders:document.getElementById('fOrders').value.trim()};\n  if(!body.name||!body.lane){document.getElementById('addErr').textContent='Name and lane are required.';return}\n  try{const r=await api('/operators',{method:'POST',body:JSON.stringify(body)});\n    active=r.operator.id;closeM('mAdd');\n    ['fName','fLane','fOrders'].forEach(i=>document.getElementById(i).value='');\n    await boot();loadMessages();\n  }catch(e){document.getElementById('addErr').textContent=e.message}\n}\nfunction closeM(id){document.getElementById(id).classList.remove('open')}\nfunction openPlans(){\n  const el=document.getElementById('planRows');el.innerHTML='';\n  Object.entries(PLANS).forEach(([k,p])=>{const d=document.createElement('div');d.className='plan'+(k===S.plan?' cur':'');\n    d.innerHTML='<div><div class=\"pn\">'+p.name+'</div><div class=\"pd\">'+p.desc+'</div></div><div class=\"pp\">'+p.price+'</div>';\n    d.onclick=async()=>{await api('/plan',{method:'POST',body:JSON.stringify({plan:k})});await boot();openPlans()};el.appendChild(d)});\n  document.getElementById('mPlan').classList.add('open');\n}\nfunction openSettings(){document.getElementById('setKey').value=BYO;document.getElementById('mSet').classList.add('open')}\nfunction saveKey(){BYO=document.getElementById('setKey').value.trim();localStorage.setItem('ag_byo',BYO);closeM('mSet')}\nfunction clearKey(){BYO='';localStorage.removeItem('ag_byo');document.getElementById('setKey').value='';closeM('mSet')}\nfunction openSchedule(){\n  const sel=document.getElementById('sOp');sel.innerHTML='';\n  S.operators.forEach(o=>{const opt=document.createElement('option');opt.value=o.id;opt.textContent=o.name+' \u2014 '+o.role;\n    if(o.id===active)opt.selected=true;sel.appendChild(opt)});\n  document.getElementById('schErr').textContent='';document.getElementById('mSch').classList.add('open');\n}\nasync function addSchedule(){\n  const body={operatorId:document.getElementById('sOp').value,hour:document.getElementById('sH').value,\n    minute:document.getElementById('sM').value,prompt:document.getElementById('sPrompt').value.trim()};\n  if(!body.operatorId||!body.prompt){document.getElementById('schErr').textContent='Pick an operator and describe the task.';return}\n  try{await api('/schedules',{method:'POST',body:JSON.stringify(body)});closeM('mSch');\n    document.getElementById('sPrompt').value='';await boot()}catch(e){document.getElementById('schErr').textContent=e.message}\n}\nasync function addFact(){\n  const t=prompt('What should your operators always know about the business?');\n  if(!t)return;await api('/facts',{method:'POST',body:JSON.stringify({text:t})});await boot();\n}\nasync function speakText(t){\n  if(S.elevenlabs){\n    try{\n      const a=await fetch('/api/tts',{method:'POST',headers:hdrs(),body:JSON.stringify({text:t})});\n      if(a.ok){const url=URL.createObjectURL(await a.blob());const audio=new Audio(url);audio.onended=()=>URL.revokeObjectURL(url);await audio.play();return}\n    }catch(e){}\n  }\n  if('speechSynthesis'in window){try{const u=new SpeechSynthesisUtterance(t);u.rate=1.05;speechSynthesis.speak(u)}catch(e){}}\n}\nfunction toggleSpeak(){speak=!speak;document.getElementById('spk').classList.toggle('on',speak)}\nlet rec=null,listening=false;\nfunction toggleMic(){\n  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;\n  if(!SR){alert('Voice input needs Chrome, Edge or Safari.');return}\n  if(listening){rec.stop();return}\n  rec=new SR();rec.lang='en-US';rec.interimResults=false;\n  rec.onstart=()=>{listening=true;document.getElementById('mic').classList.add('on')};\n  rec.onend=()=>{listening=false;document.getElementById('mic').classList.remove('on')};\n  rec.onresult=e=>{document.getElementById('inp').value=e.results[0][0].transcript;send()};\n  rec.start();\n}\n(async()=>{ // desktop/local mode needs no key\n  try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});\n    if(r.ok){const j=await r.json();if(j.local){document.getElementById('gate').style.display='none';boot();return}}}catch(e){}\n  if(KEY){document.getElementById('gate').style.display='none';boot()}\n})();\n</script>\n</body>\n</html>\n";

/* ===== server ===== */
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const WAITLIST = path.join(DATA_DIR, "waitlist.jsonl");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CLOUD_KEY = process.env.ANTHROPIC_API_KEY || "";
const LOCAL = process.env.AGENTICALLY_LOCAL === "1";
const BASE_URL = process.env.PUBLIC_URL || "https://www.getagentically.com";

/* ---------- Stripe config (set these in Railway variables when your Stripe account is ready) ---------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || "";
const PRICES = { solo: process.env.PRICE_SOLO || "", team: process.env.PRICE_TEAM || "", hq: process.env.PRICE_HQ || "", desktop: process.env.PRICE_DESKTOP || "" };
const PLANS = { solo: { seats: 1, daily: 100 }, team: { seats: 3, daily: 300 }, hq: { seats: 10, daily: 1000 }, desktop: { seats: 999, daily: 0 }, founder: { seats: 999, daily: 100000 }, canceled: { seats: 0, daily: 0 } };

fs.mkdirSync(DATA_DIR, { recursive: true });

/* Stripe webhook needs the raw body — register before json parsing */
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    if (!STRIPE_WH) return res.status(503).end();
    const sig = String(req.headers["stripe-signature"] || "");
    const t = (sig.match(/t=(\d+)/) || [])[1];
    const v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1];
    const expect = require("crypto").createHmac("sha256", STRIPE_WH).update(t + "." + req.body.toString()).digest("hex");
    if (!t || v1 !== expect) return res.status(400).end();
    const ev = JSON.parse(req.body.toString());
    if (ev.type === "customer.subscription.deleted") {
      const ws = STORE.byCustomer(ev.data.object.customer);
      if (ws && ws.plan !== "founder") { ws.plan = "canceled"; ws.planStatus = "canceled"; STORE.log(ws, "System", "subscription canceled — workspace paused"); }
    }
    res.json({ received: true });
  } catch (e) { res.status(400).end(); }
});

app.use(express.json({ limit: "200kb" }));

/* ---------- marketing site ---------- */
const page = f => (_q, res) => res.sendFile(path.join(__dirname, f));
app.get("/", page("index.html"));
app.get("/what-is-agentically", page("what-is-agentically.html"));
app.get("/robots.txt", page("robots.txt"));
app.get("/sitemap.xml", page("sitemap.xml"));
app.get("/app", (_q, res) => res.type("html").send(APP_HTML));
app.get("/terms", (_q, res) => res.type("html").send(legalPage("Terms of Service", TERMS)));
app.get("/privacy", (_q, res) => res.type("html").send(legalPage("Privacy Policy", PRIVACY)));
app.get("/healthz", (_q, res) => res.send("ok"));

/* ---------- waitlist ---------- */
const hits = new Map();
function limited(ip, max = 10) {
  const nowMs = Date.now();
  const arr = (hits.get(ip) || []).filter(t => nowMs - t < 60000);
  arr.push(nowMs); hits.set(ip, arr);
  return arr.length > max;
}
app.post("/api/waitlist", (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?");
  if (limited(ip)) return res.status(429).json({ ok: false });
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return res.status(400).json({ ok: false, error: "invalid email" });
  fs.appendFile(WAITLIST, JSON.stringify({ email, ts: new Date().toISOString(), ip }) + "\n", err => err ? res.status(500).json({ ok: false }) : res.json({ ok: true }));
});
app.get("/api/waitlist", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("forbidden");
  let raw = ""; try { raw = fs.readFileSync(WAITLIST, "utf8"); } catch (e) {}
  const rows = raw.trim() ? raw.trim().split("\n").map(l => JSON.parse(l)) : [];
  res.json({ count: rows.length, signups: rows });
});

/* ---------- workspace auth ---------- */
const LOCAL_WS = { key: "local", plan: "desktop", planStatus: "active" };
function resolveWs(key) {
  if (LOCAL) {
    const st = STORE.state();
    if (!st.workspaces.local) st.workspaces.local = Object.assign({ key: "local", plan: "desktop", planStatus: "active", email: "", stripeCustomer: "", createdAt: STORE.now(), operators: [], approvals: [], facts: [], schedules: [], activity: [], usage: {} });
    return st.workspaces.local;
  }
  return STORE.byKey(key);
}
function auth(req, res, next) {
  const ws = resolveWs(String(req.headers["x-workspace-key"] || ""));
  if (!ws) return res.status(401).json({ error: "bad key" });
  if (ws.plan === "canceled") return res.status(402).json({ error: "subscription_canceled", message: "This workspace's subscription was canceled. Visit getagentically.com to re-subscribe." });
  req.ws = ws; next();
}
const keyFor = req => String(req.headers["x-anthropic-key"] || "").trim() || CLOUD_KEY;

app.post("/api/session", (req, res) => {
  const ws = resolveWs(String((req.body || {}).key || ""));
  if (!ws) return res.status(401).json({ ok: false });
  res.json({ ok: true, cloudKey: !!CLOUD_KEY, model: MODEL, local: LOCAL, plan: ws.plan, founder: ws.plan === "founder", elevenlabs: !!process.env.ELEVENLABS_API_KEY });
});

/* ---------- workspace state ---------- */
app.get("/api/state", auth, (req, res) => {
  const ws = req.ws;
  res.json({
    plan: ws.plan, planStatus: ws.planStatus, founder: ws.plan === "founder",
    seats: (PLANS[ws.plan] || PLANS.solo).seats,
    usageToday: STORE.usageToday(ws), dailyLimit: (PLANS[ws.plan] || PLANS.solo).daily || null,
    cloudKey: !!CLOUD_KEY, model: MODEL, local: LOCAL, elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    operators: ws.operators.map(o => ({ id: o.id, name: o.name, role: o.role, lane: o.lane, orders: o.orders, messageCount: (o.messages || []).length })),
    approvals: ws.approvals.slice(0, 50), facts: ws.facts, schedules: ws.schedules, activity: ws.activity.slice(0, 30)
  });
});

app.get("/api/operators/:id/messages", auth, (req, res) => {
  const op = req.ws.operators.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: "not found" });
  res.json({ messages: (op.messages || []).slice(-60) });
});

app.post("/api/operators", auth, (req, res) => {
  const ws = req.ws;
  const limit = LOCAL ? Infinity : (PLANS[ws.plan] || PLANS.solo).seats;
  if (ws.operators.length >= limit) return res.status(402).json({ error: "seat limit reached", limit, plan: ws.plan });
  const { name, role, lane, orders } = req.body || {};
  if (!name || !role || !lane) return res.status(400).json({ error: "name, role and lane are required" });
  res.json({ operator: STORE.addOperator(ws, { name, role, lane, orders }) });
});

app.delete("/api/operators/:id", auth, (req, res) => res.json({ ok: STORE.deleteOperator(req.ws, req.params.id) }));

app.post("/api/plan", auth, (req, res) => {
  if (req.ws.plan !== "founder" && !LOCAL) return res.status(403).json({ error: "Plans are managed through billing." });
  res.json({ ok: true, plan: req.ws.plan });
});

/* ---------- agent turn ---------- */
async function operatorTurn({ ws, op, text, apiKey, source }) {
  const result = await runOperator({
    apiKey, operator: op, facts: ws.facts, userText: text,
    onApproval: input => STORE.addApproval(ws, { operatorId: op.id, operatorName: op.name, title: input.title, summary: input.summary, content: input.content }),
    onFact: f => STORE.addFact(ws, f)
  });
  op.messages = op.messages || [];
  op.messages.push({ role: "user", content: text, ts: STORE.now(), source });
  op.messages.push({ role: "assistant", content: result.text, ts: STORE.now() });
  op.messages = op.messages.slice(-120);
  STORE.save();
  return result;
}

app.post("/api/operators/:id/message", auth, async (req, res) => {
  const ws = req.ws;
  const op = ws.operators.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: "not found" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "empty message" });
  const usingOwnKey = !!String(req.headers["x-anthropic-key"] || "").trim();
  const daily = (PLANS[ws.plan] || PLANS.solo).daily;
  if (!usingOwnKey && !LOCAL && ws.plan !== "founder" && daily && STORE.usageToday(ws) >= daily)
    return res.status(429).json({ error: "daily_limit", message: "You've hit today's included usage on the " + ws.plan.toUpperCase() + " plan. It resets at midnight UTC, or add your own API key in Settings for unlimited use." });
  const apiKey = keyFor(req);
  if (!apiKey) return res.status(503).json({ error: "no_api_key", message: "No API key available. Add your own in Settings." });
  try {
    const out = await operatorTurn({ ws, op, text, apiKey, source: "chat" });
    if (!usingOwnKey) STORE.bumpUsage(ws);
    res.json({ text: out.text, approvals: out.approvals, facts: out.facts });
  } catch (e) {
    const msg = e.status === 401 ? "The API key was rejected." : e.status === 429 ? "Rate limited — try again shortly." : "Agent call failed" + (e.detail ? ": " + String(e.detail).slice(0, 200) : "");
    res.status(502).json({ error: "agent_failed", message: msg });
  }
});

/* ---------- approvals / facts / schedules ---------- */
app.post("/api/approvals/:id/:action", auth, (req, res) => {
  const a = req.params.action;
  if (a !== "approve" && a !== "reject") return res.status(400).json({ error: "bad action" });
  const item = STORE.resolveApproval(req.ws, req.params.id, a === "approve");
  if (!item) return res.status(404).json({ error: "not found" });
  res.json({ item });
});
app.post("/api/facts", auth, (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  STORE.addFact(req.ws, text);
  res.json({ ok: true, facts: req.ws.facts });
});
app.delete("/api/facts/:idx", auth, (req, res) => {
  req.ws.facts.splice(parseInt(req.params.idx, 10), 1); STORE.save();
  res.json({ ok: true, facts: req.ws.facts });
});
app.post("/api/schedules", auth, (req, res) => {
  const { operatorId, hour, minute, prompt } = req.body || {};
  const op = req.ws.operators.find(o => o.id === operatorId);
  if (!op) return res.status(400).json({ error: "unknown operator" });
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const sch = STORE.addSchedule(req.ws, { operatorId, hour, minute, prompt });
  STORE.log(req.ws, "System", "scheduled " + op.name + " daily at " + String(sch.hour).padStart(2, "0") + ":" + String(sch.minute).padStart(2, "0") + " UTC");
  res.json({ schedule: sch });
});
app.delete("/api/schedules/:id", auth, (req, res) => res.json({ ok: STORE.deleteSchedule(req.ws, req.params.id) }));
app.post("/api/schedules/:id/run", auth, async (req, res) => {
  const sch = req.ws.schedules.find(x => x.id === req.params.id);
  if (!sch) return res.status(404).json({ error: "not found" });
  const op = req.ws.operators.find(o => o.id === sch.operatorId);
  if (!op) return res.status(404).json({ error: "operator gone" });
  const apiKey = keyFor(req);
  if (!apiKey) return res.status(503).json({ error: "no_api_key" });
  try { const out = await operatorTurn({ ws: req.ws, op, text: sch.prompt, apiKey, source: "scheduled" }); res.json({ text: out.text, approvals: out.approvals }); }
  catch (e) { res.status(502).json({ error: "agent_failed" }); }
});

/* scheduled runs across every workspace */
setInterval(async () => {
  if (!CLOUD_KEY) return;
  const d = new Date();
  const key = d.toISOString().slice(0, 10) + " " + d.getUTCHours() + ":" + d.getUTCMinutes();
  for (const ws of Object.values(STORE.state().workspaces)) {
    if (ws.plan === "canceled") continue;
    for (const sch of ws.schedules || []) {
      if (sch.hour !== d.getUTCHours() || sch.minute !== d.getUTCMinutes() || sch.lastRunKey === key) continue;
      sch.lastRunKey = key; STORE.save();
      const op = ws.operators.find(o => o.id === sch.operatorId);
      if (!op) continue;
      const daily = (PLANS[ws.plan] || PLANS.solo).daily;
      if (ws.plan !== "founder" && daily && STORE.usageToday(ws) >= daily) continue;
      try { await operatorTurn({ ws, op, text: sch.prompt, apiKey: CLOUD_KEY, source: "scheduled" }); STORE.bumpUsage(ws); STORE.log(ws, op.name, "completed a scheduled run"); }
      catch (e) { STORE.log(ws, "System", "scheduled run for " + op.name + " failed"); }
    }
  }
}, 60000);

/* ---------- billing: Stripe Checkout ---------- */
async function stripe(pathName, params) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch("https://api.stripe.com/v1/" + pathName, {
    method: params ? "POST" : "GET",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: params ? body : undefined
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error && j.error.message || "stripe error"); e.status = r.status; throw e; }
  return j;
}
async function stripeGet(pathName) {
  const r = await fetch("https://api.stripe.com/v1/" + pathName, { headers: { Authorization: "Bearer " + STRIPE_KEY } });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error && j.error.message || "stripe error"); e.status = r.status; throw e; }
  return j;
}

app.get("/buy/:plan", async (req, res) => {
  const plan = req.params.plan;
  if (!PRICES.hasOwnProperty(plan)) return res.status(404).send("Unknown plan");
  if (!STRIPE_KEY || !PRICES[plan])
    return res.type("html").send(legalPage("Almost there", "<p>Checkout is being switched on. Join the waitlist on the <a href='/'>home page</a> and we'll email you the moment it's live — founding pricing locks for life.</p>"));
  try {
    const session = await stripe("checkout/sessions", {
      mode: plan === "desktop" ? "payment" : "subscription",
      "line_items[0][price]": PRICES[plan],
      "line_items[0][quantity]": "1",
      allow_promotion_codes: "true",
      success_url: BASE_URL + "/welcome?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: BASE_URL + "/#pricing",
      "metadata[plan]": plan
    });
    res.redirect(303, session.url);
  } catch (e) { res.status(502).type("html").send(legalPage("Checkout error", "<p>" + (e.message || "Something went wrong") + ". Please try again, or email hello@getagentically.com.</p>")); }
});

app.get("/welcome", async (req, res) => {
  const sid = String(req.query.session_id || "");
  if (!sid || !STRIPE_KEY) return res.redirect("/");
  try {
    const s = await stripeGet("checkout/sessions/" + encodeURIComponent(sid));
    if (s.payment_status !== "paid") return res.type("html").send(legalPage("Payment pending", "<p>Your payment hasn't completed yet. Refresh this page in a moment.</p>"));
    let ws = STORE.byCustomer(s.customer) || null;
    if (!STORE.sessionUsed(sid)) {
      const plan = (s.metadata && s.metadata.plan) || "solo";
      ws = STORE.createWorkspace({ plan, email: (s.customer_details && s.customer_details.email) || "", stripeCustomer: s.customer || "", sessionId: sid });
    }
    if (!ws) return res.type("html").send(legalPage("Welcome back", "<p>This checkout link was already used. Check where you saved your workspace key, or email hello@getagentically.com.</p>"));
    const isDesktop = ws.plan === "desktop";
    res.type("html").send(legalPage("Welcome to Agentically", `
      <p style="font-size:17px">You're in. This is your <b>workspace key</b> — it is shown once, so save it somewhere safe (a password manager is perfect):</p>
      <pre style="background:#0c1119;border:1px solid #1c2940;border-radius:10px;padding:14px;font-size:14px;word-break:break-all">${ws.key}</pre>
      ${isDesktop
        ? `<p><b>Desktop License:</b> <a href="/download/desktop?key=${ws.key}">Download Agentically for desktop</a> (needs the free Node.js runtime from nodejs.org). Unzip, double-click START-AGENTICALLY, and add your own Anthropic API key in Settings. Runs entirely on your machine.</p>`
        : `<p>Open your command center at <a href="/app">${BASE_URL.replace("https://","")}/app</a> and enter the key. Hire your first operator, teach it your business, and give it a job. Nothing ships without your approval.</p>`}
      <p style="color:#8296ac;font-size:13px">Questions? hello@getagentically.com · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>`));
  } catch (e) { res.status(502).type("html").send(legalPage("Something went wrong", "<p>We couldn't verify the payment session. Email hello@getagentically.com and we'll sort it immediately.</p>")); }
});

/* desktop package download — any paid workspace key unlocks it */
app.get("/download/desktop", (req, res) => {
  const ws = resolveWs(String(req.query.key || ""));
  if (!ws) return res.status(403).type("html").send(legalPage("Locked", "<p>A valid workspace key is required. Purchases include one on the welcome page.</p>"));
  res.redirect(302, "https://codeload.github.com/getagentically/agentically-site/zip/refs/heads/main");
});

/* ===== voice + connector ===== */
/* ---------- premium voice (ElevenLabs) ---------- */
const EL_KEY = process.env.ELEVENLABS_API_KEY || "";
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
app.post("/api/tts", auth, async (req, res) => {
  if (!EL_KEY) return res.status(503).json({ error: "no_elevenlabs_key" });
  const text = String((req.body || {}).text || "").slice(0, 900);
  if (!text) return res.status(400).json({ error: "empty" });
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + EL_VOICE + "?output_format=mp3_44100_64", {
      method: "POST",
      headers: { "xi-api-key": EL_KEY, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" })
    });
    if (!r.ok) return res.status(502).json({ error: "tts_failed", status: r.status });
    res.type("audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).json({ error: "tts_failed" }); }
});

/* ---------- Claude connector (remote MCP) — every workspace key is its own connector ---------- */
const MCP_TOOLS = [
  { name: "list_operators", description: "List this workspace's AI operators (id, name, role, lane).", inputSchema: { type: "object", properties: {} } },
  { name: "talk_to_operator", description: "Send a task or message to one of the workspace's operators and get its reply. Deliverables it produces are queued in the owner's approvals inbox, never shipped directly.", inputSchema: { type: "object", properties: { operator: { type: "string", description: "Operator name or id" }, message: { type: "string" } }, required: ["operator", "message"] } },
  { name: "list_approvals", description: "List pending items in the approvals inbox awaiting the owner's decision.", inputSchema: { type: "object", properties: {} } },
  { name: "resolve_approval", description: "Approve or reject a pending approvals-inbox item on the owner's behalf. Only use when the owner has explicitly decided.", inputSchema: { type: "object", properties: { id: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] } }, required: ["id", "decision"] } },
  { name: "add_fact", description: "Save a durable fact about the owner's business to shared operator memory.", inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "get_activity", description: "Recent workspace activity log.", inputSchema: { type: "object", properties: {} } }
];
app.get("/mcp/:wskey", (_q, res) => res.status(405).json({ error: "POST JSON-RPC to this endpoint" }));
app.post("/mcp/:wskey", async (req, res) => {
  const ws = resolveWs(req.params.wskey);
  if (!ws || ws.plan === "canceled") return res.status(401).json({ error: "unauthorized" });
  const m = req.body || {};
  const reply = result => res.json({ jsonrpc: "2.0", id: m.id, result });
  const rpcErr = (code, message) => res.json({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  const method = String(m.method || "");
  if (method === "initialize") return reply({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Agentically", version: "2.0.0" } });
  if (method.startsWith("notifications/")) return res.status(202).end();
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    const p = m.params || {}; const args = p.arguments || {};
    const text = t => reply({ content: [{ type: "text", text: t }] });
    const fail = t => reply({ content: [{ type: "text", text: t }], isError: true });
    try {
      if (p.name === "list_operators") return text(JSON.stringify(ws.operators.map(o => ({ id: o.id, name: o.name, role: o.role, lane: o.lane }))));
      if (p.name === "list_approvals") return text(JSON.stringify(ws.approvals.filter(a => a.status === "pending").map(a => ({ id: a.id, title: a.title, from: a.operatorName, summary: a.summary, content: a.content }))));
      if (p.name === "get_activity") return text(JSON.stringify(ws.activity.slice(0, 20)));
      if (p.name === "add_fact") { STORE.addFact(ws, String(args.fact || "")); return text("Saved to business memory."); }
      if (p.name === "resolve_approval") {
        const item = STORE.resolveApproval(ws, String(args.id || ""), args.decision === "approve");
        return item ? text("Item '" + item.title + "' " + item.status + ".") : fail("No pending item with that id.");
      }
      if (p.name === "talk_to_operator") {
        if (!CLOUD_KEY) return fail("No server API key configured.");
        const daily = (PLANS[ws.plan] || PLANS.solo).daily;
        if (ws.plan !== "founder" && daily && STORE.usageToday(ws) >= daily) return fail("This workspace hit today's included usage. It resets at midnight UTC.");
        const q = String(args.operator || "").toLowerCase();
        const op = ws.operators.find(o => o.id === args.operator || o.name.toLowerCase() === q);
        if (!op) return fail("Unknown operator. Use list_operators first.");
        const out = await operatorTurn({ ws, op, text: String(args.message || ""), apiKey: CLOUD_KEY, source: "connector" });
        STORE.bumpUsage(ws);
        let msg = op.name + ": " + out.text;
        if (out.approvals.length) msg += "\n\n[" + out.approvals.length + " deliverable(s) queued in the approvals inbox — the owner must approve before anything ships.]";
        return text(msg);
      }
      return rpcErr(-32602, "unknown tool");
    } catch (e) { return fail("Tool failed: " + (e.detail || e.message || "error")); }
  }
  return rpcErr(-32601, "method not found");
});

app.listen(PORT, () => console.log("Agentically v2 on :" + PORT + " (model " + MODEL + ", stripe " + (STRIPE_KEY ? "on" : "off") + ")"));
