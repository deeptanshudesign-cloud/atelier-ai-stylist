import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
let SECRET = process.env.APP_SECRET;
if (!SECRET) {
  if (PROD) { console.error("APP_SECRET is required in production."); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[warn] APP_SECRET not set: logins reset on every restart. Set it in production.");
}
if (!KEY) console.warn("[warn] ANTHROPIC_API_KEY not set: AI features run in DEMO mode with sample data.");

const db = await openDb();
console.log(`[db] using ${db.kind} PostgreSQL`);
const uid = () => crypto.randomUUID();

/* ---------- auth ---------- */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function sign(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.id, v: user.pw_hash.slice(0, 8), exp: Date.now() + 30 * 864e5 })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
function readToken(token = "") {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const good = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(payload, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
const pwMatches = (pw, user) => {
  const a = Buffer.from(hashPw(pw, user.pw_salt).hash), b = Buffer.from(user.pw_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = ah(async (req, res, next) => {
  const p = readToken((req.headers.authorization || "").replace("Bearer ", ""));
  const user = p && (await db.one("SELECT * FROM users WHERE id=$1", [p.u]));
  // The token carries a fragment of the password hash, so changing the password signs out every old session.
  if (!user || user.pw_hash.slice(0, 8) !== p.v) return res.status(401).json({ error: "Please sign in again." });
  req.user = user;
  next();
});
const publicUser = (u) => ({ id: u.id, email: u.email, profile: u.profile });

/* ---------- rate limits (per instance; swap for Redis if you run many instances) ---------- */
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 36e5)) hits.delete(k); }, 6e5).unref();
const limit = (max, windowMs) => (req, res, next) => {
  const k = (req.user?.id || req.ip) + req.path;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: "Too many requests. Please try again later." });
  arr.push(now); hits.set(k, arr); next();
};

/* ---------- AI ---------- */
async function claude({ system, user, image, tools, max_tokens = 3000 }) {
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: image.type, data: image.data } }, { type: "text", text: user }]
    : user;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages: [{ role: "user", content }], ...(tools ? { tools } : {}) }),
  });
  if (!r.ok) throw new Error(`AI service error (${r.status})`);
  const d = await r.json();
  return d.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI returned an unreadable answer. Please try again.");
  return JSON.parse(m[0]);
}
function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m || m[2].length > 5_000_000) return null;
  return { type: m[1], data: m[2] };
}

const STYLIST = `You are Atelier, a personal stylist. Create exactly 3 complete outfits for the person, one per direction:
"familiar" (close to what they already wear), "elevated" (a polished upgrade), "unexpected" (a fresh idea they would not try alone).
Respect their body type, budget, climate, occasion and the avoid-list. Prefer pieces from their wardrobe (owned:true, with wardrobe_item_id) before suggesting new ones.
Use real, purchasable brands that ship to their country; vary brand tiers. Prices in the person's local currency as a short string like "$85".
Reply with ONLY this JSON, no markdown:
{"outfits":[{"title":"","direction":"familiar|elevated|unexpected","why_it_works":"2 sentences","color_note":"","body_note":"","items":[{"slot":"Top|Bottom|Outerwear|Shoes|Accessory","name":"","brand":"","color":"","price":"","owned":false,"wardrobe_item_id":null,"note":""}],"est_total":"total of NEW pieces"}]}`;

function demoOutfits(wardrobe) {
  const own = (re) => wardrobe.find((w) => re.test(w.category));
  const piece = (slot, name, brand, color, price) => {
    const o = own(new RegExp(slot, "i"));
    return o ? { slot, name: o.name, color: o.color, owned: true, wardrobe_item_id: o.id } : { slot, name, brand, color, price, owned: false };
  };
  const mk = (title, direction, why, items) => ({ title, direction, why_it_works: why, color_note: "Neutral base with one accent.", body_note: "Structured top, relaxed bottom.", items, est_total: "$120" });
  return [
    mk("Easy Everyday", "familiar", "Demo mode: add an Anthropic API key for personalised looks.", [piece("Top", "Oxford shirt", "Uniqlo", "White", "$40"), piece("Bottom", "Straight chinos", "Dockers", "Khaki", "$55"), piece("Shoes", "Leather sneakers", "Veja", "White", "$120")]),
    mk("Quiet Polish", "elevated", "Demo mode sample look.", [piece("Top", "Merino knit", "Everlane", "Navy", "$85"), piece("Bottom", "Pleated trousers", "COS", "Grey", "$110"), piece("Shoes", "Loafers", "G.H. Bass", "Brown", "$180")]),
    mk("Off-Script", "unexpected", "Demo mode sample look.", [piece("Top", "Boxy overshirt", "Carhartt WIP", "Olive", "$130"), piece("Bottom", "Wide cargo pants", "Dickies", "Black", "$70"), piece("Shoes", "Chunky trainers", "New Balance", "Grey", "$110")]),
  ];
}

/* ---------- email ---------- */
async function sendMail(to, subject, text) {
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }),
    });
    if (!r.ok) throw new Error(`Email provider error (${r.status})`);
  } else {
    console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`); // no provider configured: print instead of sending
  }
}

/* ---------- app ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...(PROD ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  });
  next();
});
const small = express.json({ limit: "200kb" });
const big = express.json({ limit: "7mb" });
app.use((req, res, next) => (req.path.startsWith("/api/vision") ? big : small)(req, res, next));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const clean = (s, n = 200) => String(s ?? "").trim().slice(0, n);
const mapOutfit = (o) => o; // columns already match the API shape

/* accounts */
app.post("/api/auth/signup", limit(10, 36e5), ah(async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const pw = String(req.body.password ?? "");
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (req.body.agree !== true) return res.status(400).json({ error: "Please accept the Terms and Privacy Policy to continue." });
  const { salt, hash } = hashPw(pw);
  try {
    const user = await db.one("INSERT INTO users (id,email,pw_salt,pw_hash,terms_at) VALUES ($1,$2,$3,$4,now()) RETURNING *", [uid(), email, salt, hash]);
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That email already has an account." });
    throw e;
  }
}));

app.post("/api/auth/login", limit(20, 36e5), ah(async (req, res) => {
  const user = await db.one("SELECT * FROM users WHERE email=$1", [clean(req.body.email, 120).toLowerCase()]);
  if (!user || !pwMatches(String(req.body.password ?? ""), user)) return res.status(401).json({ error: "Email or password is incorrect." });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.post("/api/auth/forgot", limit(5, 36e5), ah(async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const user = await db.one("SELECT id,email FROM users WHERE email=$1", [email]);
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    await db.run("DELETE FROM reset_tokens WHERE user_id=$1 OR expires < now()", [user.id]);
    await db.run("INSERT INTO reset_tokens (token_hash,user_id,expires) VALUES ($1,$2, now() + interval '1 hour')", [sha(token), user.id]);
    try {
      await sendMail(user.email, "Reset your Atelier password",
        `Someone asked to reset the password for this account.\n\nReset it here (valid for 1 hour):\n${APP_URL}/#/reset/${token}\n\nIf this wasn't you, ignore this email: your password stays the same.`);
    } catch (e) { console.error("[mail] failed:", e.message); }
  }
  // Same answer whether or not the email exists, so accounts can't be probed.
  res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
}));

app.post("/api/auth/reset", limit(10, 36e5), ah(async (req, res) => {
  const pw = String(req.body.password ?? "");
  if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const row = await db.one("SELECT user_id FROM reset_tokens WHERE token_hash=$1 AND expires > now()", [sha(String(req.body.token ?? ""))]);
  if (!row) return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  const { salt, hash } = hashPw(pw);
  const user = await db.one("UPDATE users SET pw_salt=$1, pw_hash=$2 WHERE id=$3 RETURNING *", [salt, hash, row.user_id]);
  await db.run("DELETE FROM reset_tokens WHERE user_id=$1", [row.user_id]);
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put("/api/profile", auth, ah(async (req, res) => {
  const b = req.body;
  const profile = {
    name: clean(b.name, 60), body_type: clean(b.body_type, 60), height: clean(b.height, 20), sizes: clean(b.sizes, 80),
    budget: clean(b.budget, 40), country: clean(b.country, 60), climate: clean(b.climate, 60), styles: clean(b.styles, 160), avoid: clean(b.avoid, 200),
  };
  const user = await db.one("UPDATE users SET profile=$1::jsonb WHERE id=$2 RETURNING *", [JSON.stringify(profile), req.user.id]);
  res.json({ user: publicUser(user) });
}));

app.get("/api/account/export", auth, ah(async (req, res) => {
  const id = req.user.id;
  res.set("Content-Disposition", 'attachment; filename="atelier-my-data.json"');
  res.json({
    exported_at: new Date().toISOString(),
    account: { email: req.user.email, created: req.user.created, terms_accepted: req.user.terms_at, profile: req.user.profile },
    wardrobe: await db.rows("SELECT name,category,color,created FROM wardrobe WHERE user_id=$1 ORDER BY created", [id]),
    looks: await db.rows("SELECT title,direction,saved,brief,why_it_works,items,est_total,created FROM outfits WHERE user_id=$1 ORDER BY created", [id]),
  });
}));

app.delete("/api/account", auth, limit(5, 36e5), ah(async (req, res) => {
  if (!pwMatches(String(req.body.password ?? ""), req.user)) return res.status(403).json({ error: "Password is incorrect." });
  await db.run("DELETE FROM users WHERE id=$1", [req.user.id]); // cascades to wardrobe, looks, reset tokens
  res.json({ ok: true });
}));

/* wardrobe */
const cleanItem = (b) => ({ name: clean(b.name, 80), category: ["Top", "Bottom", "Outerwear", "Shoes", "Accessory"].includes(b.category) ? b.category : "Top", color: clean(b.color, 30) });
app.get("/api/wardrobe", auth, ah(async (req, res) =>
  res.json({ items: await db.rows("SELECT id,name,category,color,created FROM wardrobe WHERE user_id=$1 ORDER BY created DESC", [req.user.id]) })));

async function addItems(userId, list) {
  const { n } = await db.one("SELECT count(*)::int AS n FROM wardrobe WHERE user_id=$1", [userId]);
  const items = list.map(cleanItem).filter((i) => i.name).slice(0, Math.max(0, 300 - n));
  const out = [];
  for (const i of items) out.push(await db.one("INSERT INTO wardrobe (id,user_id,name,category,color) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,category,color,created", [uid(), userId, i.name, i.category, i.color]));
  return { out, full: n + items.length >= 300 };
}
app.post("/api/wardrobe", auth, ah(async (req, res) => {
  if (!clean(req.body.name, 80)) return res.status(400).json({ error: "Give the item a name." });
  const { out, full } = await addItems(req.user.id, [req.body]);
  if (!out.length && full) return res.status(400).json({ error: "Wardrobe is full (300 items)." });
  res.json({ item: out[0] });
}));
app.post("/api/wardrobe/bulk", auth, ah(async (req, res) => {
  const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 40) : [];
  res.json({ items: (await addItems(req.user.id, list)).out });
}));
app.delete("/api/wardrobe/:id", auth, ah(async (req, res) => {
  await db.run("DELETE FROM wardrobe WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* looks */
app.post("/api/outfits/generate", auth, limit(15, 36e5), ah(async (req, res) => {
  const wardrobe = await db.rows("SELECT id,name,category,color FROM wardrobe WHERE user_id=$1 ORDER BY created DESC LIMIT 300", [req.user.id]);
  const brief = {
    occasion: clean(req.body.occasion, 100) || "everyday", mood: clean(req.body.mood, 100), weather: clean(req.body.weather, 80),
    budget: clean(req.body.budget, 40) || req.user.profile.budget, inspiration: clean(req.body.inspiration, 400),
    discovery: ["familiar", "balanced", "experimental"].includes(req.body.discovery) ? req.body.discovery : "balanced", adjust: clean(req.body.adjust, 200),
  };
  try {
    let outfits;
    if (!KEY) outfits = demoOutfits(wardrobe);
    else {
      outfits = (parseJSON(await claude({ system: STYLIST, user: JSON.stringify({ profile: req.user.profile, brief, wardrobe }) })).outfits ?? []).slice(0, 3);
      if (!outfits.length) throw new Error("No looks were returned. Please try again.");
    }
    const rows = [];
    for (const o of outfits) {
      const items = (Array.isArray(o.items) ? o.items : []).slice(0, 8).map((i) => ({
        slot: clean(i.slot, 30), name: clean(i.name, 100), brand: clean(i.brand, 60), color: clean(i.color, 30), price: clean(i.price, 20),
        owned: Boolean(i.owned), wardrobe_item_id: i.wardrobe_item_id || null, note: clean(i.note, 200),
      }));
      rows.push(await db.one(
        `INSERT INTO outfits (id,user_id,brief,title,direction,why_it_works,color_note,body_note,est_total,items)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [uid(), req.user.id, JSON.stringify(brief), clean(o.title, 80) || "Untitled look", clean(o.direction, 20), clean(o.why_it_works, 400),
          clean(o.color_note, 200), clean(o.body_note, 200), clean(o.est_total, 30), JSON.stringify(items)]));
    }
    res.json({ outfits: rows, demo: !KEY });
  } catch (e) {
    if (e.message?.startsWith("AI") || e.message?.startsWith("The AI") || e.message?.startsWith("No looks")) return res.status(502).json({ error: e.message });
    throw e;
  }
}));

app.get("/api/outfits", auth, ah(async (req, res) =>
  res.json({ outfits: await db.rows(`SELECT * FROM outfits WHERE user_id=$1 ${req.query.recent ? "" : "AND saved"} ORDER BY created DESC LIMIT 30`, [req.user.id]) })));

app.post("/api/outfits/:id/save", auth, ah(async (req, res) => {
  const r = await db.one("UPDATE outfits SET saved = NOT saved WHERE id=$1 AND user_id=$2 RETURNING saved", [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: "Look not found." });
  res.json({ saved: r.saved });
}));

app.post("/api/outfits/:id/verify", auth, limit(20, 36e5), ah(async (req, res) => {
  const o = await db.one("SELECT * FROM outfits WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!o) return res.status(404).json({ error: "Look not found." });
  const now = new Date().toISOString();
  const todo = o.items.map((it, i) => ({ it, i })).filter(({ it }) => !it.owned);
  try {
    const found = {};
    if (KEY && todo.length) {
      const text = await claude({
        max_tokens: 3000, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        system: `Find a live retailer product page for each clothing item, shipping to ${req.user.profile.country || "the user's country"}. Only report what the page shows. Reply with ONLY JSON: {"results":[{"index":0,"status":"verified|out_of_stock|not_found","url":"","retailer":"","price":"","shipping":"","returns":""}]}`,
        user: JSON.stringify(todo.map(({ it, i }) => ({ index: i, brand: it.brand, name: it.name, color: it.color }))),
      });
      for (const r of parseJSON(text).results ?? []) found[r.index] = r;
    }
    for (const { it, i } of todo) {
      const r = found[i];
      it.verified = r && /^https?:\/\//.test(r.url || "") && r.status !== "not_found"
        ? { status: r.status === "out_of_stock" ? "out_of_stock" : "verified", url: r.url, retailer: clean(r.retailer, 60), price: clean(r.price, 20), shipping: clean(r.shipping, 80), returns: clean(r.returns, 80), checked_at: now }
        : { status: "not_found", url: null, retailer: null, price: null, shipping: null, returns: null, checked_at: now };
    }
    await db.run("UPDATE outfits SET items=$1::jsonb WHERE id=$2", [JSON.stringify(o.items), o.id]);
    res.json({ items: o.items });
  } catch {
    res.status(502).json({ error: "Couldn't check live listings right now. Try again in a moment." });
  }
}));

/* vision: photos are analysed in memory and never stored */
app.post("/api/vision/scan-closet", auth, limit(10, 36e5), ah(async (req, res) => {
  const image = parseImage(req.body.image);
  if (!image) return res.status(400).json({ error: "Upload a JPEG, PNG or WebP photo under 5 MB." });
  if (!KEY) return res.json({ demo: true, items: [{ name: "Light-wash jeans", category: "Bottom", color: "Blue" }, { name: "White t-shirt", category: "Top", color: "White" }, { name: "Black denim jacket", category: "Outerwear", color: "Black" }] });
  try {
    const text = await claude({
      image, max_tokens: 1500,
      system: `You catalogue clothing from a photo of a closet, bed or rack. List each distinct garment, shoe or accessory you can clearly see. Reply with ONLY JSON: {"items":[{"name":"short descriptive name","category":"Top|Bottom|Outerwear|Shoes|Accessory","color":"main colour"}]}. Max 20 items. Do not guess hidden items.`,
      user: "Catalogue the clothing in this photo.",
    });
    res.json({ items: (parseJSON(text).items ?? []).slice(0, 20).map(cleanItem).filter((i) => i.name) });
  } catch { res.status(502).json({ error: "Couldn't read that photo. Try better light or a closer shot." }); }
}));

app.post("/api/vision/tryon", auth, limit(10, 36e5), ah(async (req, res) => {
  const image = parseImage(req.body.image);
  if (!image) return res.status(400).json({ error: "The photo wasn't readable. Try again." });
  const o = await db.one("SELECT * FROM outfits WHERE id=$1 AND user_id=$2", [String(req.body.outfit_id || ""), req.user.id]);
  if (!o) return res.status(404).json({ error: "Pick a look first." });
  if (!KEY) return res.json({ demo: true, feedback: { score: 82, summary: "Demo mode: add an API key for a real fit check.", works: ["Colours sit well together", "Proportions look balanced"], tweaks: ["Try rolling the sleeves once", "Tuck the front of the top"] } });
  try {
    const text = await claude({
      image, max_tokens: 1200,
      system: `You are a kind, honest stylist doing a fit check. The person is photographed wearing what they have on; they are considering a planned look. Compare their body proportions, colouring and current outfit with the planned look and judge how well the planned look would suit them. Never comment on body weight or attractiveness; talk only about fit, proportion, colour and styling. Reply with ONLY JSON: {"score":0-100,"summary":"2 sentences","works":["max 3"],"tweaks":["max 3 specific changes"]}`,
      user: `Planned look: ${o.title}. Pieces: ${o.items.map((i) => `${i.slot}: ${i.color} ${i.name}`).join("; ")}. Profile: ${JSON.stringify(req.user.profile)}`,
    });
    const f = parseJSON(text);
    res.json({ feedback: { score: Math.max(0, Math.min(100, Number(f.score) || 0)), summary: clean(f.summary, 400), works: (f.works || []).slice(0, 3).map((s) => clean(s, 160)), tweaks: (f.tweaks || []).slice(0, 3).map((s) => clean(s, 160)) } });
  } catch { res.status(502).json({ error: "Couldn't check the fit right now. Try again." }); }
}));

app.get("/healthz", ah(async (_, res) => { await db.one("SELECT 1"); res.send("ok"); }));
app.get(["/privacy", "/terms"], (req, res) => res.sendFile(path.join(__dirname, "public", req.path.slice(1) + ".html")));
app.use("/api", (_, res) => res.status(404).json({ error: "Not found" }));
app.use((_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That file is too large." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => console.log(`Atelier running on ${APP_URL}`));
