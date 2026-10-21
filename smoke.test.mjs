// Start the server first (logging to a file), then:  SERVER_LOG=/tmp/srv.log node smoke.test.mjs
const B = process.env.BASE || "http://localhost:3111";
const call = async (p, m = "GET", body, tok) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 40); }
  return [r.status, j];
};
let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log(c ? "PASS" : "FAIL", n); };
const rnd = Math.random().toString(36).slice(2, 8);
let [s, j] = await call("/api/auth/signup", "POST", { email: `a${rnd}@b.co`, password: "password123", agree: true }); const T = j.token; ok("signup", s === 200 && T);
[s] = await call("/api/auth/signup", "POST", { email: `a${rnd}@b.co`, password: "password123", agree: true }); ok("duplicate email rejected", s === 409);
[s] = await call("/api/auth/signup", "POST", { email: "x@y.co", password: "short" }); ok("short password rejected", s === 400);
[s] = await call("/api/auth/login", "POST", { email: `a${rnd}@b.co`, password: "wrong-pass" }); ok("bad login rejected", s === 401);
[s, j] = await call("/api/auth/login", "POST", { email: `a${rnd}@b.co`, password: "password123", agree: true }); ok("login", s === 200 && j.token);
[s] = await call("/api/wardrobe"); ok("wardrobe requires auth", s === 401);
[s] = await call("/api/wardrobe", "GET", null, "bad.token"); ok("forged token rejected", s === 401);
[s, j] = await call("/api/profile", "PUT", { name: "Ravi", country: "India" }, T); ok("profile save", s === 200 && j.user.profile.name === "Ravi");
[s, j] = await call("/api/wardrobe", "POST", { name: "Navy shirt", category: "Top", color: "Navy" }, T); ok("wardrobe add", s === 200); const wid = j.item?.id;
[s, j] = await call("/api/outfits/generate", "POST", { occasion: "dinner" }, T); ok("generate returns 3 looks", s === 200 && j.outfits.length === 3);
ok("uses owned wardrobe piece first", j.outfits[0].items.some((i) => i.owned && i.name === "Navy shirt"));
const id = j.outfits[0].id;
[s, j] = await call(`/api/outfits/${id}/save`, "POST", null, T); ok("save look", j.saved === true);
[s, j] = await call(`/api/outfits/${id}/verify`, "POST", null, T); ok("verify returns status per new piece", s === 200 && j.items.filter((i) => !i.owned).every((i) => i.verified?.status));
[s, j] = await call("/api/outfits", "GET", null, T); ok("saved list", j.outfits.length === 1);
[s, j] = await call("/api/auth/signup", "POST", { email: `c${rnd}@d.co`, password: "password123", agree: true }); const T2 = j.token;
[s] = await call(`/api/outfits/${id}/save`, "POST", null, T2); ok("other user cannot touch my look", s === 404);
[s, j] = await call("/api/wardrobe", "GET", null, T2); ok("wardrobe isolated per user", j.items.length === 0);
await call(`/api/wardrobe/${wid}`, "DELETE", null, T2); [s, j] = await call("/api/wardrobe", "GET", null, T); ok("other user cannot delete my item", j.items.length === 1);
for (const p of ["/", "/app.js", "/styles.css", "/healthz", "/create"]) { const r = await fetch(B + p); ok("GET " + p, r.status === 200); }
ok("security headers", (await fetch(B + "/")).headers.get("x-frame-options") === "DENY");
[s] = await call("/api/nope"); ok("unknown api route 404", s === 404);

import fs from "node:fs";
// --- terms must be accepted
[s] = await call("/api/auth/signup", "POST", { email: `n${rnd}@b.co`, password: "password123" }); ok("signup requires accepting terms", s === 400);
// --- vision (demo mode returns samples; invalid images are rejected)
const img = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD";
[s, j] = await call("/api/vision/scan-closet", "POST", { image: img }, T); ok("closet scan returns items", s === 200 && j.items.length > 0);
[s] = await call("/api/vision/scan-closet", "POST", { image: "not an image" }, T); ok("closet scan rejects bad image", s === 400);
[s] = await call("/api/vision/scan-closet", "POST", { image: img }); ok("closet scan requires auth", s === 401);
[s, j] = await call("/api/vision/tryon", "POST", { image: img, outfit_id: id }, T); ok("try-on returns feedback", s === 200 && j.feedback.score >= 0 && Array.isArray(j.feedback.tweaks));
[s] = await call("/api/vision/tryon", "POST", { image: img, outfit_id: id }, T2); ok("try-on blocked for someone else's look", s === 404);
[s, j] = await call("/api/wardrobe/bulk", "POST", { items: [{ name: "Grey hoodie", category: "Top", color: "Grey" }, { name: "", category: "Top" }] }, T); ok("bulk add skips blanks", s === 200 && j.items.length === 1);
// --- password reset
[s, j] = await call("/api/auth/forgot", "POST", { email: `nobody${rnd}@x.co` }); ok("forgot gives same answer for unknown email", s === 200 && j.ok);
[s, j] = await call("/api/auth/forgot", "POST", { email: `a${rnd}@b.co` }); ok("forgot for real account", s === 200 && j.ok);
await new Promise((r) => setTimeout(r, 300));
const log = fs.readFileSync(process.env.SERVER_LOG || "/tmp/srv.log", "utf8");
const tok = [...log.matchAll(/#\/reset\/([a-f0-9]{64})/g)].pop()?.[1];
ok("reset link was emailed (dev log)", Boolean(tok));
[s] = await call("/api/auth/reset", "POST", { token: "0".repeat(64), password: "newpassword1" }); ok("bad reset token rejected", s === 400);
[s, j] = await call("/api/auth/reset", "POST", { token: tok, password: "newpassword1" }); ok("reset works", s === 200 && j.token);
const T3 = j.token;
[s] = await call("/api/wardrobe", "GET", null, T); ok("old sessions signed out after reset", s === 401);
[s] = await call("/api/auth/reset", "POST", { token: tok, password: "another-pass1" }); ok("reset link is single-use", s === 400);
[s] = await call("/api/auth/login", "POST", { email: `a${rnd}@b.co`, password: "newpassword1" }); ok("login with new password", s === 200);
// --- export + delete
[s, j] = await call("/api/account/export", "GET", null, T3); ok("data export", s === 200 && j.account.email === `a${rnd}@b.co` && j.wardrobe.length >= 2);
[s] = await call("/api/account", "DELETE", { password: "wrong" }, T3); ok("delete needs correct password", s === 403);
[s] = await call("/api/account", "DELETE", { password: "newpassword1" }, T3); ok("account deleted", s === 200);
[s] = await call("/api/auth/login", "POST", { email: `a${rnd}@b.co`, password: "newpassword1" }); ok("deleted account cannot sign in", s === 401);
for (const p of ["/privacy", "/terms"]) { const r = await fetch(B + p); ok("GET " + p, r.status === 200 && (await r.text()).includes("<h1>")); }
console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
