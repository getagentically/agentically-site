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



/* ===== store ===== */
// Simple durable JSON store. Point DATA_DIR at a Railway volume for persistence across deploys.



const S_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(S_DATA_DIR, "workspace.json");
fs.mkdirSync(S_DATA_DIR, { recursive: true });

const BLANK = { operators: [], approvals: [], facts: [], schedules: [], activity: [], plan: "hq" };

function load() {
  try {
    return Object.assign({}, BLANK, JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (e) {
    return JSON.parse(JSON.stringify(BLANK));
  }
}

let state = load();
let writeTimer = null;
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }, 50);
}

const id = p => p + "_" + Math.random().toString(36).slice(2, 9);
const now = () => new Date().toISOString();

function log(who, what) {
  state.activity.unshift({ ts: now(), who, what });
  state.activity = state.activity.slice(0, 200);
  save();
}

const STORE = {
  get: () => state,
  save,
  id,
  now,
  log,
  addOperator(o) {
    const op = {
      id: id("op"),
      name: o.name,
      role: o.role,
      lane: o.lane,
      orders: o.orders || "",
      createdAt: now(),
      messages: []
    };
    state.operators.push(op);
    log(op.name, "hired as " + op.role + " operator");
    save();
    return op;
  },
  deleteOperator(opId) {
    const op = state.operators.find(o => o.id === opId);
    state.operators = state.operators.filter(o => o.id !== opId);
    state.schedules = state.schedules.filter(s => s.operatorId !== opId);
    if (op) log(op.name, "removed from the roster");
    save();
    return !!op;
  },
  addApproval(a) {
    const item = {
      id: id("ap"),
      operatorId: a.operatorId,
      operatorName: a.operatorName,
      title: a.title,
      summary: a.summary,
      content: a.content,
      status: "pending",
      createdAt: now()
    };
    state.approvals.unshift(item);
    log(a.operatorName, 'queued "' + a.title + '" for approval');
    save();
    return item;
  },
  resolveApproval(apId, approved) {
    const item = state.approvals.find(a => a.id === apId);
    if (!item) return null;
    item.status = approved ? "approved" : "rejected";
    item.resolvedAt = now();
    log("You", (approved ? "approved" : "rejected") + ' "' + item.title + '"');
    save();
    return item;
  },
  addFact(text) {
    if (!text || state.facts.some(f => f.text === text)) return null;
    const f = { text, ts: now() };
    state.facts.push(f);
    save();
    return f;
  },
  addSchedule(s) {
    const sch = {
      id: id("sch"),
      operatorId: s.operatorId,
      hour: Math.max(0, Math.min(23, parseInt(s.hour, 10) || 9)),
      minute: Math.max(0, Math.min(59, parseInt(s.minute, 10) || 0)),
      prompt: s.prompt,
      lastRunKey: null,
      createdAt: now()
    };
    state.schedules.push(sch);
    save();
    return sch;
  },
  deleteSchedule(schId) {
    const before = state.schedules.length;
    state.schedules = state.schedules.filter(s => s.id !== schId);
    save();
    return state.schedules.length < before;
  }
};

const store = STORE;

/* ===== app shell ===== */
const APP_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Agentically HQ</title>\n<meta name=\"robots\" content=\"noindex\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{--bg:#06080d;--panel:#0c1119;--panel2:#101828;--line:#1c2940;--text:#dbe4ee;--dim:#8296ac;\n    --accent:#37e0c8;--accent2:#5aa2ff;--warn:#ffb454;--danger:#ff6b6b;\n    --mono:'JetBrains Mono',ui-monospace,Consolas,monospace;--sans:'Inter',system-ui,-apple-system,sans-serif}\n  *{box-sizing:border-box}\n  html,body{height:100%;margin:0}\n  body{background:var(--bg);color:var(--text);font-family:var(--sans);display:flex;flex-direction:column}\n  button,input,select,textarea{font-family:inherit}\n  button{cursor:pointer}\n  a{color:var(--accent2);text-decoration:none}\n  header{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}\n  .logo{font-weight:800;font-size:17px;color:#fff}.logo span{color:var(--accent)}\n  .chip{font-family:var(--mono);font-size:11px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 12px}\n  .chip.act{color:var(--accent);border-color:rgba(55,224,200,.4)}\n  .chip.warn{color:var(--warn);border-color:rgba(255,180,84,.4)}\n  main{flex:1;display:grid;grid-template-columns:265px 1fr 320px;min-height:0}\n  @media(max-width:980px){main{grid-template-columns:1fr;overflow:auto}.col{border-right:none!important;border-bottom:1px solid var(--line);max-height:none!important}}\n  .col{min-height:0;overflow-y:auto;border-right:1px solid var(--line);padding:14px}\n  .ct{font-family:var(--mono);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);margin:0 0 10px;display:flex;justify-content:space-between;align-items:center}\n  .op{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-bottom:9px;cursor:pointer}\n  .op:hover{border-color:#2a3d5c}\n  .op.on{border-color:var(--accent);background:linear-gradient(90deg,rgba(55,224,200,.07),var(--panel))}\n  .op .nm{font-weight:700;color:#fff;font-size:14px}\n  .op .rl{font-family:var(--mono);font-size:10px;color:var(--accent);margin:2px 0 5px;letter-spacing:.08em}\n  .op .st{font-size:12px;color:var(--dim)}\n  .dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--accent);margin-right:6px}\n  .btn{background:var(--accent);border:none;border-radius:9px;color:#04211c;font-weight:700;padding:9px 16px;font-size:13.5px}\n  .btn.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:500}\n  .btn.ghost:hover{color:var(--accent);border-color:var(--accent)}\n  .btn.dash{width:100%;background:transparent;border:1px dashed var(--line);color:var(--dim);padding:11px;border-radius:11px;font-size:13.5px}\n  .btn.dash:hover{color:var(--accent);border-color:var(--accent)}\n  .chat{display:flex;flex-direction:column;padding:0}\n  .chead{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n  .chead .who{font-weight:700;color:#fff}\n  .chead .lane{font-family:var(--mono);font-size:11px;color:var(--accent)}\n  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;min-height:240px}\n  .msg{max-width:84%;padding:11px 15px;border-radius:14px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}\n  .msg.user{align-self:flex-end;background:var(--panel2);border:1px solid var(--line);border-bottom-right-radius:4px}\n  .msg.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}\n  .msg .tag{font-family:var(--mono);font-size:10px;color:var(--accent);display:block;margin-bottom:5px;letter-spacing:.1em}\n  .msg.sys{align-self:center;background:transparent;border:1px dashed var(--line);color:var(--dim);font-size:12.5px;max-width:92%}\n  .bar{display:flex;gap:8px;padding:13px 15px;border-top:1px solid var(--line)}\n  .bar input{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 15px;color:#fff;font-size:15px}\n  .bar input:focus{outline:none;border-color:var(--accent)}\n  .ico{background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--dim);width:46px;font-size:16px}\n  .ico.on{color:var(--accent);border-color:var(--accent);box-shadow:0 0 14px rgba(55,224,200,.25)}\n  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:9px}\n  .card.ap{border-left:3px solid var(--warn)}\n  .card .t{font-size:13.5px;color:#fff;font-weight:600}\n  .card .d{font-size:12.5px;color:var(--dim);margin:4px 0 8px}\n  .card pre{background:#080d15;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;color:var(--text);white-space:pre-wrap;max-height:190px;overflow:auto;margin:0 0 9px;font-family:var(--mono)}\n  .card button{font-size:12px;border-radius:8px;padding:6px 13px;border:1px solid var(--line);background:transparent;margin-right:6px;color:var(--dim)}\n  .card .ok{color:#04211c;background:var(--accent);border-color:var(--accent);font-weight:700}\n  .card .no{color:var(--danger)}\n  .feed{font-size:12.5px;color:var(--dim);border-left:2px solid var(--line);padding:2px 0 2px 11px;margin-bottom:8px}\n  .feed b{color:var(--text);font-weight:600}\n  .feed .tm{font-family:var(--mono);font-size:10px;color:#54677e;display:block}\n  .fact{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--dim);padding:6px 0;border-bottom:1px solid #141c28}\n  .fact button{background:none;border:none;color:#54677e;font-size:14px;padding:0 4px}\n  .fact button:hover{color:var(--danger)}\n  .modal{position:fixed;inset:0;background:rgba(3,6,10,.8);display:none;align-items:center;justify-content:center;padding:18px;z-index:60}\n  .modal.open{display:flex}\n  .box{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:24px;max-width:460px;width:100%;max-height:88vh;overflow:auto}\n  .box h3{margin:0 0 4px;color:#fff}\n  .box p.s{color:var(--dim);font-size:13.5px;margin:0 0 14px}\n  .box label{font-family:var(--mono);font-size:10.5px;color:var(--dim);letter-spacing:.1em;display:block;margin:12px 0 5px}\n  .box input,.box select,.box textarea{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 13px;color:#fff;font-size:14px}\n  .box textarea{resize:vertical;min-height:58px}\n  .box .row{display:flex;gap:10px;margin-top:19px;justify-content:flex-end}\n  .plan{display:flex;justify-content:space-between;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 15px;cursor:pointer;margin-bottom:9px}\n  .plan:hover,.plan.cur{border-color:var(--accent)}\n  .plan .pn{font-weight:700;color:#fff;font-size:14px}\n  .plan .pd{font-size:12px;color:var(--dim)}\n  .plan .pp{font-family:var(--mono);color:var(--accent);font-size:14px}\n  .empty{color:#54677e;font-size:12.5px;text-align:center;margin:14px 0}\n  .gate{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:80}\n  .gate .box{max-width:380px;text-align:center}\n  .err{color:var(--danger);font-size:12.5px;margin-top:8px;min-height:16px}\n  .thinking{display:inline-block;animation:blink 1.2s infinite}\n  @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}\n</style>\n</head>\n<body>\n\n<div class=\"gate\" id=\"gate\">\n  <div class=\"box\">\n    <h3>agentic<span style=\"color:var(--accent)\">ally</span> HQ</h3>\n    <p class=\"s\">Enter your workspace key to open your command center.</p>\n    <input id=\"gateKey\" type=\"password\" placeholder=\"Workspace key\" onkeydown=\"if(event.key==='Enter')unlock()\">\n    <div class=\"err\" id=\"gateErr\"></div>\n    <div class=\"row\" style=\"justify-content:center\"><button class=\"btn\" onclick=\"unlock()\">Open HQ</button></div>\n  </div>\n</div>\n\n<header>\n  <div class=\"logo\">agentic<span>ally</span> <span style=\"color:var(--dim);font-weight:400;font-size:12px\">HQ</span></div>\n  <span class=\"chip\" id=\"modelChip\">\u2014</span>\n  <span style=\"flex:1\"></span>\n  <button class=\"chip act\" id=\"planChip\" onclick=\"openPlans()\">PLAN</button>\n  <button class=\"chip\" onclick=\"openSettings()\">\u2699 Settings</button>\n</header>\n\n<main>\n  <div class=\"col\">\n    <p class=\"ct\">Operators <span id=\"seats\"></span></p>\n    <div id=\"ops\"></div>\n    <button class=\"btn dash\" onclick=\"tryAdd()\">+ Hire an operator</button>\n    <p class=\"ct\" style=\"margin-top:22px\">Business memory</p>\n    <div id=\"facts\"></div>\n    <button class=\"btn ghost\" style=\"width:100%;margin-top:8px;font-size:12.5px\" onclick=\"addFact()\">+ Add a fact</button>\n  </div>\n\n  <div class=\"col chat\">\n    <div class=\"chead\">\n      <span class=\"dot\"></span><span class=\"who\" id=\"who\">No operator</span><span class=\"lane\" id=\"lane\"></span>\n      <span style=\"flex:1\"></span>\n      <button class=\"ico\" id=\"spk\" title=\"Speak replies\" onclick=\"toggleSpeak()\" style=\"width:auto;padding:7px 11px;font-size:12.5px\">\ud83d\udd0a voice</button>\n      <button class=\"ico\" id=\"schBtn\" title=\"Schedule a run\" onclick=\"openSchedule()\" style=\"width:auto;padding:7px 11px;font-size:12.5px\">\u23f0 schedule</button>\n    </div>\n    <div class=\"msgs\" id=\"msgs\"></div>\n    <div class=\"bar\">\n      <button class=\"ico\" id=\"mic\" title=\"Talk\" onclick=\"toggleMic()\">\ud83c\udf99</button>\n      <input id=\"inp\" placeholder=\"Type or talk to your operator\u2026\" onkeydown=\"if(event.key==='Enter')send()\">\n      <button class=\"btn\" onclick=\"send()\">Send</button>\n    </div>\n  </div>\n\n  <div class=\"col\">\n    <p class=\"ct\">Approvals inbox</p>\n    <div id=\"aps\"></div>\n    <p class=\"empty\" id=\"apsEmpty\">Nothing waiting on you.</p>\n    <p class=\"ct\" style=\"margin-top:22px\">Scheduled runs</p>\n    <div id=\"schs\"></div>\n    <p class=\"ct\" style=\"margin-top:22px\">Activity</p>\n    <div id=\"feed\"></div>\n  </div>\n</main>\n\n<div class=\"modal\" id=\"mAdd\"><div class=\"box\">\n  <h3>Hire an operator</h3>\n  <p class=\"s\">Give it a name, a lane, and standing orders. It shows up every day.</p>\n  <label>NAME</label><input id=\"fName\" placeholder=\"e.g., Maya\">\n  <label>ROLE</label>\n  <select id=\"fRole\"><option>Marketing</option><option>Operations</option><option>Client Services</option><option>Research</option><option>Analyst</option><option>Custom</option></select>\n  <label>LANE \u2014 WHAT IT OWNS</label><input id=\"fLane\" placeholder=\"e.g., content + social for my shop\">\n  <label>STANDING ORDERS</label><textarea id=\"fOrders\" placeholder=\"e.g., Nothing posts without my approval. Always show sources.\"></textarea>\n  <div class=\"err\" id=\"addErr\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mAdd')\">Cancel</button><button class=\"btn\" onclick=\"addOp()\">Hire</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mPlan\"><div class=\"box\">\n  <h3>Your plan</h3>\n  <p class=\"s\">Seats control how many operators you can run.</p>\n  <div id=\"planRows\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mPlan')\">Close</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mSet\"><div class=\"box\">\n  <h3>Settings</h3>\n  <p class=\"s\">Bring your own Anthropic API key to run operators on your own account (desktop / BYO-key mode). Stored only in this browser and sent straight to Anthropic.</p>\n  <label>ANTHROPIC API KEY</label><input id=\"setKey\" type=\"password\" placeholder=\"sk-ant-\u2026\">\n  <p class=\"s\" style=\"margin-top:10px\" id=\"cloudNote\"></p>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"clearKey()\">Clear</button><button class=\"btn\" onclick=\"saveKey()\">Save</button></div>\n</div></div>\n\n<div class=\"modal\" id=\"mSch\"><div class=\"box\">\n  <h3>Schedule a run</h3>\n  <p class=\"s\">Your operator runs this on its own each day and queues the result in your approvals inbox.</p>\n  <label>OPERATOR</label><select id=\"sOp\"></select>\n  <label>TIME (UTC, 24H)</label>\n  <div style=\"display:flex;gap:8px\"><input id=\"sH\" type=\"number\" min=\"0\" max=\"23\" value=\"13\" style=\"width:80px\"><input id=\"sM\" type=\"number\" min=\"0\" max=\"59\" value=\"0\" style=\"width:80px\"></div>\n  <label>WHAT SHOULD IT DO?</label><textarea id=\"sPrompt\" placeholder=\"e.g., Draft this week's 3 social posts and queue them for my approval.\"></textarea>\n  <div class=\"err\" id=\"schErr\"></div>\n  <div class=\"row\"><button class=\"btn ghost\" onclick=\"closeM('mSch')\">Cancel</button><button class=\"btn\" onclick=\"addSchedule()\">Schedule</button></div>\n</div></div>\n\n<script>\nconst SEATS={solo:1,team:3,hq:10};\nconst PLANS={solo:{name:'SOLO',price:'$19/mo',desc:'1 operator'},team:{name:'TEAM',price:'$49/mo',desc:'3 operators + scheduled runs'},hq:{name:'HQ',price:'$99/mo',desc:'10 operators'}};\nlet KEY=localStorage.getItem('ag_key')||'';\nlet BYO=localStorage.getItem('ag_byo')||'';\nlet S={operators:[],approvals:[],facts:[],schedules:[],activity:[],plan:'hq'};\nlet active=null, speak=false, busy=false;\n\nconst esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nfunction hdrs(){const h={'Content-Type':'application/json','x-workspace-key':KEY};if(BYO)h['x-anthropic-key']=BYO;return h}\nasync function api(path,opts={}){const r=await fetch('/api'+path,{...opts,headers:hdrs()});\n  if(r.status===401){localStorage.removeItem('ag_key');location.reload();return}\n  let j={};try{j=await r.json()}catch(e){}\n  if(!r.ok)throw Object.assign(new Error(j.message||j.error||'request failed'),{data:j});return j}\n\nasync function unlock(){\n  const k=document.getElementById('gateKey').value.trim();\n  const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});\n  if(!r.ok){document.getElementById('gateErr').textContent='That key was not accepted.';return}\n  KEY=k;localStorage.setItem('ag_key',k);document.getElementById('gate').style.display='none';boot();\n}\nasync function boot(){\n  try{S=await api('/state')}catch(e){return}\n  document.getElementById('modelChip').textContent=S.model;\n  document.getElementById('cloudNote').textContent=S.cloudKey\n    ?'A workspace key is configured on the server, so operators work without your own key.'\n    :'No server key is set \u2014 add your own key above to run operators.';\n  if(!active&&S.operators.length)active=S.operators[0].id;\n  render();\n  if(active)loadMessages();\n}\nfunction render(){renderOps();renderFacts();renderAps();renderSchs();renderFeed();\n  document.getElementById('planChip').textContent='PLAN: '+PLANS[S.plan].name;\n  document.getElementById('seats').textContent=S.local?S.operators.length+' operators':S.operators.length+'/'+SEATS[S.plan]+' seats';\n  if(S.local){document.getElementById('planChip').style.display='none'}\n  const op=S.operators.find(o=>o.id===active);\n  document.getElementById('who').textContent=op?op.name:'No operator';\n  document.getElementById('lane').textContent=op?'\u00b7 '+op.role.toUpperCase():'';\n}\nfunction renderOps(){\n  const el=document.getElementById('ops');el.innerHTML='';\n  if(!S.operators.length){el.innerHTML='<p class=\"empty\">No operators yet. Hire your first one below.</p>';return}\n  S.operators.forEach(o=>{const d=document.createElement('div');d.className='op'+(o.id===active?' on':'');\n    d.innerHTML='<div class=\"nm\">'+esc(o.name)+'</div><div class=\"rl\">'+esc(o.role).toUpperCase()+'</div><div class=\"st\"><span class=\"dot\"></span>'+esc(o.lane)+'</div>';\n    d.onclick=()=>{active=o.id;render();loadMessages()};el.appendChild(d)});\n}\nfunction renderFacts(){\n  const el=document.getElementById('facts');el.innerHTML='';\n  if(!S.facts.length){el.innerHTML='<p class=\"empty\">Nothing recorded yet.</p>';return}\n  S.facts.forEach((f,i)=>{const d=document.createElement('div');d.className='fact';\n    d.innerHTML='<span>'+esc(f.text)+'</span>';\n    const b=document.createElement('button');b.textContent='\u00d7';b.onclick=async()=>{await api('/facts/'+i,{method:'DELETE'});boot()};\n    d.appendChild(b);el.appendChild(d)});\n}\nfunction renderAps(){\n  const el=document.getElementById('aps');el.innerHTML='';\n  const pend=S.approvals.filter(a=>a.status==='pending');\n  document.getElementById('apsEmpty').style.display=pend.length?'none':'block';\n  pend.forEach(a=>{const d=document.createElement('div');d.className='card ap';\n    d.innerHTML='<div class=\"t\">'+esc(a.title)+'</div><div class=\"d\">from '+esc(a.operatorName)+' \u2014 '+esc(a.summary)+'</div><pre>'+esc(a.content)+'</pre>';\n    const ok=document.createElement('button');ok.className='ok';ok.textContent='Approve';ok.onclick=()=>resolveAp(a.id,'approve');\n    const no=document.createElement('button');no.className='no';no.textContent='Reject';no.onclick=()=>resolveAp(a.id,'reject');\n    d.appendChild(ok);d.appendChild(no);el.appendChild(d)});\n}\nfunction renderSchs(){\n  const el=document.getElementById('schs');el.innerHTML='';\n  if(!S.schedules.length){el.innerHTML='<p class=\"empty\">No scheduled runs.</p>';return}\n  S.schedules.forEach(s=>{const op=S.operators.find(o=>o.id===s.operatorId);\n    const d=document.createElement('div');d.className='card';\n    d.innerHTML='<div class=\"t\">'+esc(op?op.name:'(removed)')+' \u00b7 '+String(s.hour).padStart(2,'0')+':'+String(s.minute).padStart(2,'0')+' UTC</div><div class=\"d\">'+esc(s.prompt)+'</div>';\n    const run=document.createElement('button');run.textContent='Run now';run.onclick=async()=>{run.textContent='Running\u2026';\n      try{await api('/schedules/'+s.id+'/run',{method:'POST'});await boot()}catch(e){alert(e.message)}};\n    const del=document.createElement('button');del.className='no';del.textContent='Delete';del.onclick=async()=>{await api('/schedules/'+s.id,{method:'DELETE'});boot()};\n    d.appendChild(run);d.appendChild(del);el.appendChild(d)});\n}\nfunction renderFeed(){\n  const el=document.getElementById('feed');el.innerHTML='';\n  S.activity.slice(0,14).forEach(f=>{const d=document.createElement('div');d.className='feed';\n    d.innerHTML='<span class=\"tm\">'+new Date(f.ts).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</span><b>'+esc(f.who)+'</b> '+esc(f.what);\n    el.appendChild(d)});\n}\nasync function loadMessages(){\n  const m=document.getElementById('msgs');m.innerHTML='';\n  if(!active)return;\n  const op=S.operators.find(o=>o.id===active);\n  let msgs=[];try{msgs=(await api('/operators/'+active+'/messages')).messages}catch(e){}\n  if(!msgs.length){\n    const w=document.createElement('div');w.className='msg assistant';\n    w.innerHTML='<span class=\"tag\">'+esc(op.name).toUpperCase()+' \u00b7 '+esc(op.role).toUpperCase()+'</span>'+\n      \"I'm \"+esc(op.name)+\", your \"+esc(op.role.toLowerCase())+\" operator. My lane: \"+esc(op.lane)+\". What do you want handled?\";\n    m.appendChild(w);\n  }\n  msgs.forEach(x=>{const d=document.createElement('div');d.className='msg '+x.role;\n    d.innerHTML=(x.role==='assistant'?'<span class=\"tag\">'+esc(op.name).toUpperCase()+(x.source==='scheduled'?' \u00b7 SCHEDULED':'')+'</span>':'')+esc(x.content);\n    m.appendChild(d)});\n  m.scrollTop=m.scrollHeight;\n}\nasync function send(){\n  if(busy)return;\n  const inp=document.getElementById('inp');const t=inp.value.trim();\n  if(!t)return;\n  if(!active){alert('Hire an operator first.');return}\n  inp.value='';busy=true;\n  const m=document.getElementById('msgs');\n  const u=document.createElement('div');u.className='msg user';u.textContent=t;m.appendChild(u);\n  const think=document.createElement('div');think.className='msg assistant';\n  think.innerHTML='<span class=\"thinking\">working\u2026</span>';m.appendChild(think);m.scrollTop=m.scrollHeight;\n  try{\n    const r=await api('/operators/'+active+'/message',{method:'POST',body:JSON.stringify({text:t})});\n    think.innerHTML='<span class=\"tag\">'+esc(S.operators.find(o=>o.id===active).name).toUpperCase()+'</span>'+esc(r.text);\n    if(speak){await speakText(r.text.slice(0,600))}\n    const st=await api('/state');S=st;renderAps();renderFacts();renderFeed();\n  }catch(e){\n    think.className='msg sys';\n    think.textContent=e.data&&e.data.error==='no_api_key'\n      ? 'No Anthropic API key configured. Open Settings to add your own key, or set one on the server.'\n      : (e.message||'Something went wrong.');\n  }\n  busy=false;m.scrollTop=m.scrollHeight;\n}\nasync function resolveAp(id,action){await api('/approvals/'+id+'/'+action,{method:'POST'});await boot()}\nfunction tryAdd(){\n  if(!S.local&&S.operators.length>=SEATS[S.plan]){openPlans();return}\n  document.getElementById('addErr').textContent='';document.getElementById('mAdd').classList.add('open');\n}\nasync function addOp(){\n  const body={name:document.getElementById('fName').value.trim(),role:document.getElementById('fRole').value,\n    lane:document.getElementById('fLane').value.trim(),orders:document.getElementById('fOrders').value.trim()};\n  if(!body.name||!body.lane){document.getElementById('addErr').textContent='Name and lane are required.';return}\n  try{const r=await api('/operators',{method:'POST',body:JSON.stringify(body)});\n    active=r.operator.id;closeM('mAdd');\n    ['fName','fLane','fOrders'].forEach(i=>document.getElementById(i).value='');\n    await boot();loadMessages();\n  }catch(e){document.getElementById('addErr').textContent=e.message}\n}\nfunction closeM(id){document.getElementById(id).classList.remove('open')}\nfunction openPlans(){\n  const el=document.getElementById('planRows');el.innerHTML='';\n  Object.entries(PLANS).forEach(([k,p])=>{const d=document.createElement('div');d.className='plan'+(k===S.plan?' cur':'');\n    d.innerHTML='<div><div class=\"pn\">'+p.name+'</div><div class=\"pd\">'+p.desc+'</div></div><div class=\"pp\">'+p.price+'</div>';\n    d.onclick=async()=>{await api('/plan',{method:'POST',body:JSON.stringify({plan:k})});await boot();openPlans()};el.appendChild(d)});\n  document.getElementById('mPlan').classList.add('open');\n}\nfunction openSettings(){document.getElementById('setKey').value=BYO;document.getElementById('mSet').classList.add('open')}\nfunction saveKey(){BYO=document.getElementById('setKey').value.trim();localStorage.setItem('ag_byo',BYO);closeM('mSet')}\nfunction clearKey(){BYO='';localStorage.removeItem('ag_byo');document.getElementById('setKey').value='';closeM('mSet')}\nfunction openSchedule(){\n  const sel=document.getElementById('sOp');sel.innerHTML='';\n  S.operators.forEach(o=>{const opt=document.createElement('option');opt.value=o.id;opt.textContent=o.name+' \u2014 '+o.role;\n    if(o.id===active)opt.selected=true;sel.appendChild(opt)});\n  document.getElementById('schErr').textContent='';document.getElementById('mSch').classList.add('open');\n}\nasync function addSchedule(){\n  const body={operatorId:document.getElementById('sOp').value,hour:document.getElementById('sH').value,\n    minute:document.getElementById('sM').value,prompt:document.getElementById('sPrompt').value.trim()};\n  if(!body.operatorId||!body.prompt){document.getElementById('schErr').textContent='Pick an operator and describe the task.';return}\n  try{await api('/schedules',{method:'POST',body:JSON.stringify(body)});closeM('mSch');\n    document.getElementById('sPrompt').value='';await boot()}catch(e){document.getElementById('schErr').textContent=e.message}\n}\nasync function addFact(){\n  const t=prompt('What should your operators always know about the business?');\n  if(!t)return;await api('/facts',{method:'POST',body:JSON.stringify({text:t})});await boot();\n}\nasync function speakText(t){\n  if(S.elevenlabs){\n    try{\n      const a=await fetch('/api/tts',{method:'POST',headers:hdrs(),body:JSON.stringify({text:t})});\n      if(a.ok){const url=URL.createObjectURL(await a.blob());const audio=new Audio(url);audio.onended=()=>URL.revokeObjectURL(url);await audio.play();return}\n    }catch(e){}\n  }\n  if('speechSynthesis'in window){try{const u=new SpeechSynthesisUtterance(t);u.rate=1.05;speechSynthesis.speak(u)}catch(e){}}\n}\nfunction toggleSpeak(){speak=!speak;document.getElementById('spk').classList.toggle('on',speak)}\nlet rec=null,listening=false;\nfunction toggleMic(){\n  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;\n  if(!SR){alert('Voice input needs Chrome, Edge or Safari.');return}\n  if(listening){rec.stop();return}\n  rec=new SR();rec.lang='en-US';rec.interimResults=false;\n  rec.onstart=()=>{listening=true;document.getElementById('mic').classList.add('on')};\n  rec.onend=()=>{listening=false;document.getElementById('mic').classList.remove('on')};\n  rec.onresult=e=>{document.getElementById('inp').value=e.results[0][0].transcript;send()};\n  rec.start();\n}\n(async()=>{ // desktop/local mode needs no key\n  try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});\n    if(r.ok){const j=await r.json();if(j.local){document.getElementById('gate').style.display='none';boot();return}}}catch(e){}\n  if(KEY){document.getElementById('gate').style.display='none';boot()}\n})();\n</script>\n</body>\n</html>\n";

/* ===== server ===== */






const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const WAITLIST = path.join(DATA_DIR, "waitlist.jsonl");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CLOUD_KEY = process.env.ANTHROPIC_API_KEY || "";

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "200kb" }));

/* ---------- marketing site (flat files) ---------- */
const page = f => (_q, res) => res.sendFile(path.join(__dirname, f));
app.get("/", page("index.html"));
app.get("/what-is-agentically", page("what-is-agentically.html"));
app.get("/robots.txt", page("robots.txt"));
app.get("/sitemap.xml", page("sitemap.xml"));
app.get("/app", (_q,res)=>res.type("html").send(APP_HTML));
app.get("/healthz", (_q, res) => res.send("ok"));

/* ---------- waitlist ---------- */
const hits = new Map();
function limited(ip, max = 10) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
app.post("/api/waitlist", (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?");
  if (limited(ip)) return res.status(429).json({ ok: false, error: "slow down" });
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)
    return res.status(400).json({ ok: false, error: "invalid email" });
  fs.appendFile(WAITLIST, JSON.stringify({ email, ts: new Date().toISOString(), ip }) + "\n", err =>
    err ? res.status(500).json({ ok: false }) : res.json({ ok: true })
  );
});
app.get("/api/waitlist", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("forbidden");
  let raw = "";
  try { raw = fs.readFileSync(WAITLIST, "utf8"); } catch (e) {}
  const rows = raw.trim() ? raw.trim().split("\n").map(l => JSON.parse(l)) : [];
  res.json({ count: rows.length, signups: rows });
});

/* ---------- workspace auth ---------- */
const LOCAL = process.env.AGENTICALLY_LOCAL === "1"; // desktop mode: local machine, no key gate, unlimited seats
function auth(req, res, next) {
  if (LOCAL) return next();
  if (!ADMIN_KEY) return res.status(503).json({ error: "workspace not configured" });
  const key = req.headers["x-workspace-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "bad key" });
  next();
}
// per-request Anthropic key: cloud key by default, or the caller's own (desktop / BYO-key mode)
const keyFor = req => String(req.headers["x-anthropic-key"] || "").trim() || CLOUD_KEY;

app.post("/api/session", (req, res) => {
  const ok = LOCAL || (ADMIN_KEY && (req.body || {}).key === ADMIN_KEY);
  res.status(ok ? 200 : 401).json({ ok, cloudKey: !!CLOUD_KEY, model: MODEL, local: LOCAL });
});

/* ---------- workspace state ---------- */
app.get("/api/state", auth, (req, res) => {
  const s = store.get();
  res.json({
    plan: s.plan,
    cloudKey: !!CLOUD_KEY,
    model: MODEL,
    local: LOCAL,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    operators: s.operators.map(o => ({
      id: o.id, name: o.name, role: o.role, lane: o.lane, orders: o.orders,
      messageCount: (o.messages || []).length
    })),
    approvals: s.approvals.slice(0, 50),
    facts: s.facts,
    schedules: s.schedules,
    activity: s.activity.slice(0, 30)
  });
});

app.get("/api/operators/:id/messages", auth, (req, res) => {
  const op = store.get().operators.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: "not found" });
  res.json({ messages: (op.messages || []).slice(-60) });
});

const SEATS = { solo: 1, team: 3, hq: 10 };
app.post("/api/operators", auth, (req, res) => {
  const s = store.get();
  const limit = LOCAL ? Infinity : (SEATS[s.plan] || 1);
  if (s.operators.length >= limit)
    return res.status(402).json({ error: "seat limit reached", limit, plan: s.plan });
  const { name, role, lane, orders } = req.body || {};
  if (!name || !role || !lane) return res.status(400).json({ error: "name, role and lane are required" });
  res.json({ operator: store.addOperator({ name, role, lane, orders }) });
});

app.delete("/api/operators/:id", auth, (req, res) => {
  res.json({ ok: store.deleteOperator(req.params.id) });
});

app.post("/api/plan", auth, (req, res) => {
  const plan = (req.body || {}).plan;
  if (!SEATS[plan]) return res.status(400).json({ error: "unknown plan" });
  store.get().plan = plan;
  store.log("System", "plan switched to " + plan.toUpperCase());
  store.save();
  res.json({ ok: true, plan });
});

/* ---------- the actual agent turn ---------- */
async function operatorTurn({ op, text, apiKey, source }) {
  const s = store.get();
  const result = await runOperator({
    apiKey,
    operator: op,
    facts: s.facts,
    userText: text,
    onApproval: input =>
      store.addApproval({
        operatorId: op.id, operatorName: op.name,
        title: input.title, summary: input.summary, content: input.content
      }),
    onFact: f => store.addFact(f)
  });
  op.messages = op.messages || [];
  op.messages.push({ role: "user", content: text, ts: store.now(), source });
  op.messages.push({ role: "assistant", content: result.text, ts: store.now() });
  op.messages = op.messages.slice(-120);
  store.save();
  return result;
}

app.post("/api/operators/:id/message", auth, async (req, res) => {
  const op = store.get().operators.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: "not found" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "empty message" });
  const apiKey = keyFor(req);
  if (!apiKey)
    return res.status(503).json({ error: "no_api_key", message: "No Anthropic API key configured. Add one in Settings (or set ANTHROPIC_API_KEY on the server)." });
  try {
    const out = await operatorTurn({ op, text, apiKey, source: "chat" });
    res.json({ text: out.text, approvals: out.approvals, facts: out.facts });
  } catch (e) {
    const msg = e.status === 401 ? "The Anthropic API key was rejected." :
      e.status === 429 ? "Rate limited by Anthropic — try again shortly." :
      "Agent call failed" + (e.detail ? ": " + e.detail : "");
    res.status(502).json({ error: "agent_failed", message: msg });
  }
});

/* ---------- approvals ---------- */
app.post("/api/approvals/:id/:action", auth, (req, res) => {
  const action = req.params.action;
  if (action !== "approve" && action !== "reject") return res.status(400).json({ error: "bad action" });
  const item = store.resolveApproval(req.params.id, action === "approve");
  if (!item) return res.status(404).json({ error: "not found" });
  res.json({ item });
});

/* ---------- facts ---------- */
app.post("/api/facts", auth, (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  store.addFact(text);
  res.json({ ok: true, facts: store.get().facts });
});
app.delete("/api/facts/:idx", auth, (req, res) => {
  const s = store.get();
  s.facts.splice(parseInt(req.params.idx, 10), 1);
  store.save();
  res.json({ ok: true, facts: s.facts });
});

/* ---------- scheduled runs ---------- */
app.post("/api/schedules", auth, (req, res) => {
  const { operatorId, hour, minute, prompt } = req.body || {};
  const op = store.get().operators.find(o => o.id === operatorId);
  if (!op) return res.status(400).json({ error: "unknown operator" });
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const sch = store.addSchedule({ operatorId, hour, minute, prompt });
  store.log("System", "scheduled " + op.name + " daily at " + String(sch.hour).padStart(2, "0") + ":" + String(sch.minute).padStart(2, "0") + " UTC");
  res.json({ schedule: sch });
});
app.delete("/api/schedules/:id", auth, (req, res) => {
  res.json({ ok: store.deleteSchedule(req.params.id) });
});
app.post("/api/schedules/:id/run", auth, async (req, res) => {
  const s = store.get();
  const sch = s.schedules.find(x => x.id === req.params.id);
  if (!sch) return res.status(404).json({ error: "not found" });
  const op = s.operators.find(o => o.id === sch.operatorId);
  if (!op) return res.status(404).json({ error: "operator gone" });
  const apiKey = keyFor(req);
  if (!apiKey) return res.status(503).json({ error: "no_api_key" });
  try {
    const out = await operatorTurn({ op, text: sch.prompt, apiKey, source: "scheduled" });
    res.json({ text: out.text, approvals: out.approvals });
  } catch (e) {
    res.status(502).json({ error: "agent_failed", message: e.detail || "run failed" });
  }
});

// minute ticker — runs due schedules with the cloud key
setInterval(async () => {
  if (!CLOUD_KEY) return;
  const s = store.get();
  const d = new Date();
  const key = d.toISOString().slice(0, 10) + " " + d.getUTCHours() + ":" + d.getUTCMinutes();
  for (const sch of s.schedules) {
    if (sch.hour !== d.getUTCHours() || sch.minute !== d.getUTCMinutes()) continue;
    if (sch.lastRunKey === key) continue;
    sch.lastRunKey = key;
    store.save();
    const op = s.operators.find(o => o.id === sch.operatorId);
    if (!op) continue;
    try {
      await operatorTurn({ op, text: sch.prompt, apiKey: CLOUD_KEY, source: "scheduled" });
      store.log(op.name, "completed a scheduled run");
    } catch (e) {
      store.log("System", "scheduled run for " + op.name + " failed");
    }
  }
}, 60000);


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

/* ---------- Claude connector (remote MCP, streamable HTTP) ---------- */
const MCP_TOOLS = [
  { name: "list_operators", description: "List the workspace's AI operators (id, name, role, lane).", inputSchema: { type: "object", properties: {} } },
  { name: "talk_to_operator", description: "Send a task or message to one of the workspace's operators and get its reply. Deliverables it produces are queued in the owner's approvals inbox, never shipped directly.", inputSchema: { type: "object", properties: { operator: { type: "string", description: "Operator name or id" }, message: { type: "string" } }, required: ["operator", "message"] } },
  { name: "list_approvals", description: "List pending items in the approvals inbox awaiting the owner's decision.", inputSchema: { type: "object", properties: {} } },
  { name: "resolve_approval", description: "Approve or reject a pending approvals-inbox item on the owner's behalf. Only use when the owner has explicitly decided.", inputSchema: { type: "object", properties: { id: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] } }, required: ["id", "decision"] } },
  { name: "add_fact", description: "Save a durable fact about the owner's business to shared operator memory.", inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "get_activity", description: "Recent workspace activity log.", inputSchema: { type: "object", properties: {} } }
];
app.get("/mcp/:wskey", (req, res) => res.status(405).json({ error: "POST JSON-RPC to this endpoint" }));
app.post("/mcp/:wskey", async (req, res) => {
  if (!ADMIN_KEY || req.params.wskey !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const m = req.body || {};
  const reply = result => res.json({ jsonrpc: "2.0", id: m.id, result });
  const rpcErr = (code, message) => res.json({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  const method = String(m.method || "");
  if (method === "initialize")
    return reply({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Agentically", version: "1.0.0" } });
  if (method.startsWith("notifications/")) return res.status(202).end();
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    const p = m.params || {}; const args = p.arguments || {}; const s = store.get();
    const text = t => reply({ content: [{ type: "text", text: t }] });
    const fail = t => reply({ content: [{ type: "text", text: t }], isError: true });
    try {
      if (p.name === "list_operators")
        return text(JSON.stringify(s.operators.map(o => ({ id: o.id, name: o.name, role: o.role, lane: o.lane }))));
      if (p.name === "list_approvals")
        return text(JSON.stringify(s.approvals.filter(a => a.status === "pending").map(a => ({ id: a.id, title: a.title, from: a.operatorName, summary: a.summary, content: a.content }))));
      if (p.name === "get_activity")
        return text(JSON.stringify(s.activity.slice(0, 20)));
      if (p.name === "add_fact") { store.addFact(String(args.fact || "")); return text("Saved to business memory."); }
      if (p.name === "resolve_approval") {
        const item = store.resolveApproval(String(args.id || ""), args.decision === "approve");
        return item ? text("Item '" + item.title + "' " + item.status + ".") : fail("No pending item with that id.");
      }
      if (p.name === "talk_to_operator") {
        if (!CLOUD_KEY) return fail("No server API key configured.");
        const q = String(args.operator || "").toLowerCase();
        const op = s.operators.find(o => o.id === args.operator || o.name.toLowerCase() === q);
        if (!op) return fail("Unknown operator. Use list_operators first.");
        const out = await operatorTurn({ op, text: String(args.message || ""), apiKey: CLOUD_KEY, source: "connector" });
        let msg = op.name + ": " + out.text;
        if (out.approvals.length) msg += "\n\n[" + out.approvals.length + " deliverable(s) queued in the approvals inbox — the owner must approve before anything ships.]";
        return text(msg);
      }
      return rpcErr(-32602, "unknown tool");
    } catch (e) { return fail("Tool failed: " + (e.detail || e.message || "error")); }
  }
  return rpcErr(-32601, "method not found");
});

app.listen(PORT, () => console.log("Agentically on :" + PORT + " (model " + MODEL + ")"));
