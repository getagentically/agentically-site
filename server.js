const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const WAITLIST = path.join(DATA_DIR, "waitlist.jsonl");
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // set in Railway variables

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "10kb" }));

// flat-file static routes (repo has no subfolders)
const page = f => (_q, res) => res.sendFile(path.join(__dirname, f));
app.get("/", page("index.html"));
app.get("/what-is-agentically", page("what-is-agentically.html"));
app.get("/robots.txt", page("robots.txt"));
app.get("/sitemap.xml", page("sitemap.xml"));
app.get("/healthz", (_q, res) => res.send("ok"));

// naive in-memory rate limit per IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

app.post("/api/waitlist", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (limited(String(ip))) return res.status(429).json({ ok: false, error: "slow down" });
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)
    return res.status(400).json({ ok: false, error: "invalid email" });
  const line = JSON.stringify({ email, ts: new Date().toISOString(), ip }) + "\n";
  fs.appendFile(WAITLIST, line, err => {
    if (err) return res.status(500).json({ ok: false });
    res.json({ ok: true });
  });
});

// view signups: GET /api/waitlist?key=ADMIN_KEY
app.get("/api/waitlist", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("forbidden");
  let raw = "";
  try { raw = fs.readFileSync(WAITLIST, "utf8"); } catch (e) {}
  const rows = raw.trim() ? raw.trim().split("\n").map(l => JSON.parse(l)) : [];
  res.json({ count: rows.length, signups: rows });
});

app.listen(PORT, () => console.log("Agentically site on :" + PORT));
