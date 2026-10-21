"use strict";
/* Atelier front end: vanilla JS, hash routing. User text is always set via textContent (no innerHTML). */

const $app = document.getElementById("app");
const $bar = document.getElementById("bar");
const state = { token: localStorage.getItem("atelier_token"), user: null, wardrobe: null, stream: null };

/* ---------- helpers ---------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 3000);
}
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token && !path.startsWith("/auth")) { signOut(false); throw new Error("Please sign in again."); }
  if (!r.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function setSession(d) {
  state.token = d.token; state.user = d.user; state.wardrobe = null;
  localStorage.setItem("atelier_token", d.token);
}
function signOut(go = true) {
  localStorage.removeItem("atelier_token");
  Object.assign(state, { token: null, user: null, wardrobe: null });
  if (go) location.hash = "#/";
  render();
}
function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (!(m >= 1)) return "just now";
  if (m < 60) return m + " min ago";
  const hr = Math.round(m / 60);
  return hr < 24 ? hr + " hr ago" : Math.round(hr / 24) + " d ago";
}
const field = (label, input, hint) => h("label", {}, label, input, hint && h("span", { class: "hint" }, hint));
const seg = (name, options, value) =>
  h("div", { class: "seg", role: "radiogroup" }, options.map(([v, l]) =>
    h("label", {}, h("input", { type: "radio", name, value: v, checked: v === value }), h("span", {}, l))));
const picked = (form, name) => form.querySelector(`input[name="${name}"]:checked`)?.value || "";
const errBox = () => h("p", { class: "err", hidden: true, role: "alert" });
const showErr = (box, msg) => { box.textContent = msg; box.hidden = false; };

/* Downscale any image or video frame to a JPEG data URL (keeps uploads small and fast). */
function toJpeg(source, maxSide = 1024) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const hgt = source.videoHeight || source.naturalHeight || source.height;
  const k = Math.min(1, maxSide / Math.max(w, hgt));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(hgt * k);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
function fileToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { try { resolve(toJpeg(img)); } catch (e) { reject(e); } URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a readable image.")); };
    img.src = url;
  });
}
function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

/* ---------- nav ---------- */
function renderBar() {
  const route = location.hash.replace("#/", "").split("/")[0];
  const link = (to, label) => h("a", { href: "#/" + to, "aria-current": route === to ? "page" : false }, label);
  $bar.replaceChildren(h("div", { class: "bar-in" },
    h("a", { class: "brand", href: "#/" }, "Atelier"),
    state.user
      ? h("nav", { class: "nav", "aria-label": "Main" }, link("create", "Create"), link("tryon", "Try on"), link("wardrobe", "Wardrobe"), link("saved", "Saved"), link("profile", "Profile"),
          h("button", { onclick: () => signOut() }, "Sign out"))
      : h("nav", { class: "nav" }, link("login", "Sign in"))));
}

/* ---------- views ---------- */
function landing() {
  return h("div", {},
    h("section", { class: "hero" },
      h("h1", {}, "You don't need more clothes. You need a stylist."),
      h("p", {}, "Tell Atelier the occasion and the mood. Get three complete outfits made for your body, your budget and the clothes you already own."),
      h("div", { class: "row" },
        h("a", { class: "btn", href: state.user ? "#/create" : "#/signup" }, state.user ? "Create a look" : "Build my style profile"),
        !state.user && h("a", { class: "btn ghost", href: "#/login" }, "Sign in"))),
    h("div", { class: "steps" },
      h("div", {}, h("h3", {}, "Describe it"), h("p", {}, "An occasion, a mood, or a look you saw and liked.")),
      h("div", {}, h("h3", {}, "Get three directions"), h("p", {}, "Familiar, elevated and unexpected, each explained.")),
      h("div", {}, h("h3", {}, "Check the fit, then buy"), h("p", {}, "Try a look on with your camera and check live listings for price, stock and returns."))));
}

function authView(mode) {
  const signup = mode === "signup";
  const err = errBox();
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      const d = await api(`/auth/${signup ? "signup" : "login"}`, "POST", { email: form.email.value, password: form.password.value, agree: signup ? form.agree.checked : undefined });
      setSession(d);
      location.hash = signup || !d.user.profile?.name ? "#/profile" : "#/create";
    } catch (x) { showErr(err, x.message); }
  } },
    field("Email", h("input", { name: "email", type: "email", required: true, autocomplete: "email" })),
    field("Password", h("input", { name: "password", type: "password", required: true, minLength: 8, autocomplete: signup ? "new-password" : "current-password" }), signup && "At least 8 characters"),
    signup && h("label", { class: "check" }, h("input", { name: "agree", type: "checkbox", required: true }),
      h("span", {}, "I agree to the ", h("a", { href: "/terms", target: "_blank" }, "Terms"), " and ", h("a", { href: "/privacy", target: "_blank" }, "Privacy Policy"), ".")),
    err,
    h("button", { class: "btn" }, signup ? "Create account" : "Sign in"),
    !signup && h("p", { class: "note" }, h("a", { href: "#/forgot" }, "Forgot your password?")),
    h("p", { class: "note" }, signup ? "Already have an account? " : "New here? ",
      h("a", { href: signup ? "#/login" : "#/signup" }, signup ? "Sign in" : "Create an account")));
  return h("div", { class: "panel narrow" }, h("h2", {}, signup ? "Create your account" : "Welcome back"), form);
}

function forgotView() {
  const err = errBox();
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      const d = await api("/auth/forgot", "POST", { email: form.email.value });
      panel.replaceChildren(h("h2", {}, "Check your email"), h("p", {}, d.message), h("a", { class: "btn ghost", href: "#/login" }, "Back to sign in"));
    } catch (x) { showErr(err, x.message); }
  } },
    field("Email", h("input", { name: "email", type: "email", required: true, autocomplete: "email" })), err,
    h("button", { class: "btn" }, "Send reset link"));
  const panel = h("div", { class: "panel narrow stack" }, h("h2", {}, "Reset your password"), h("p", { class: "note" }, "Enter your email and we'll send a link that works for one hour."), form);
  return panel;
}

function resetView(token) {
  const err = errBox();
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      setSession(await api("/auth/reset", "POST", { token, password: form.password.value }));
      toast("Password updated");
      location.hash = "#/create";
    } catch (x) { showErr(err, x.message); }
  } },
    field("New password", h("input", { name: "password", type: "password", required: true, minLength: 8, autocomplete: "new-password" }), "At least 8 characters"), err,
    h("button", { class: "btn" }, "Set new password"));
  return h("div", { class: "panel narrow stack" }, h("h2", {}, "Choose a new password"), form);
}

function profileView() {
  const p = state.user.profile || {};
  const i = (name, label, hint, extra = {}) => field(label, h("input", { name, value: p[name] || "", ...extra }), hint);
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    try { state.user = (await api("/profile", "PUT", Object.fromEntries(new FormData(form)))).user; toast("Profile saved"); location.hash = "#/create"; }
    catch (x) { toast(x.message); }
  } },
    h("div", { class: "grid2" },
      i("name", "First name", null, { required: true }),
      i("country", "Country", "So we suggest brands that ship to you"),
      i("height", "Height", "e.g. 170 cm"),
      i("sizes", "Usual sizes", "e.g. M tops, 32 trousers, UK 8 shoes"),
      field("Body type", h("select", { name: "body_type" }, ["", "Slim", "Athletic", "Average", "Curvy", "Broad", "Petite", "Tall", "Plus size"].map((v) => h("option", { value: v, selected: v === p.body_type }, v || "Select…")))),
      field("Usual budget per piece", h("select", { name: "budget" }, ["", "Under $30", "$30–80", "$80–200", "$200+"].map((v) => h("option", { value: v, selected: v === p.budget }, v || "Select…")))),
      i("climate", "Climate", "e.g. hot and dry, mild, cold winters")),
    i("styles", "Styles you like", "e.g. minimal, streetwear, old money"),
    i("avoid", "Anything to avoid", "e.g. no skinny fits, no bright colours"),
    h("button", { class: "btn" }, "Save profile"));

  const exportBtn = h("button", { class: "btn ghost", onclick: async () => {
    try {
      const r = await fetch("/api/account/export", { headers: { authorization: "Bearer " + state.token } });
      if (!r.ok) throw new Error("Couldn't export your data.");
      const url = URL.createObjectURL(await r.blob());
      const a = h("a", { href: url, download: "atelier-my-data.json" }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (x) { toast(x.message); }
  } }, "Download my data");
  const delErr = errBox();
  const delForm = h("form", { class: "stack", hidden: true, onsubmit: async (e) => {
    e.preventDefault(); delErr.hidden = true;
    try { await api("/account", "DELETE", { password: delForm.password.value }); signOut(); toast("Your account was deleted"); }
    catch (x) { showErr(delErr, x.message); }
  } },
    field("Confirm with your password", h("input", { name: "password", type: "password", required: true, autocomplete: "current-password" }), "This permanently deletes your profile, wardrobe and looks."),
    delErr, h("button", { class: "btn ghost danger" }, "Delete my account permanently"));
  return h("div", {},
    h("div", { class: "head" }, h("h2", {}, "Your style profile")), h("div", { class: "panel" }, form),
    h("div", { class: "spacer" }),
    h("div", { class: "panel stack" }, h("h3", {}, "Your data"),
      h("p", { class: "note" }, "Download everything we hold about you, or delete your account. See our ", h("a", { href: "/privacy" }, "Privacy Policy"), "."),
      h("div", { class: "actions" }, exportBtn, h("button", { class: "btn ghost danger", onclick: () => { delForm.hidden = !delForm.hidden; } }, "Delete account…")), delForm));
}

function createView() {
  const out = h("div", { class: "looks", "aria-live": "polite" });
  let busy = false;
  const form = h("form", { class: "panel stack", onsubmit: (e) => { e.preventDefault(); run(); } },
    h("div", { class: "grid2" },
      field("Occasion", h("input", { name: "occasion", placeholder: "Dinner with friends, office, wedding…", required: true })),
      field("Mood", h("input", { name: "mood", placeholder: "Relaxed, sharp, playful…" })),
      field("Weather", h("input", { name: "weather", placeholder: "Warm, 30°C" }))),
    field("A look you like (optional)", h("textarea", { name: "inspiration", placeholder: "Describe it: 'oversized beige blazer, white tee, wide jeans'" })),
    h("div", {}, h("p", { class: "label" }, "How adventurous?"), seg("discovery", [["familiar", "Familiar"], ["balanced", "Balanced"], ["experimental", "Experimental"]], "balanced")),
    h("button", { class: "btn", id: "go" }, "Create three looks"));

  async function run(adjust = "") {
    if (busy) return;
    busy = true; form.querySelector("#go").disabled = true;
    out.replaceChildren(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
    try {
      const d = await api("/outfits/generate", "POST", { occasion: form.occasion.value, mood: form.mood.value, weather: form.weather.value, inspiration: form.inspiration.value, discovery: picked(form, "discovery"), adjust });
      out.replaceChildren(
        d.demo && h("p", { class: "err" }, "Demo mode: these are sample looks. Add an Anthropic API key on the server for personalised ones."),
        ...d.outfits.map((o) => lookCard(o)));
    } catch (x) { out.replaceChildren(h("p", { class: "err", role: "alert" }, x.message)); }
    finally { busy = false; form.querySelector("#go").disabled = false; }
  }
  return h("div", {}, h("div", { class: "head" }, h("h2", {}, "Create a look")), form, out);
}

const DIRECTION = { familiar: "Familiar", elevated: "Elevated", unexpected: "Unexpected" };

function lookCard(o) {
  const piecesBox = h("div", { class: "pieces" });
  const saveBtn = h("button", { class: "btn ghost small", onclick: async () => {
    try { const d = await api(`/outfits/${o.id}/save`, "POST"); o.saved = d.saved; saveBtn.textContent = d.saved ? "Saved ✓" : "Save look"; toast(d.saved ? "Saved to your looks" : "Removed"); }
    catch (x) { toast(x.message); }
  } }, o.saved ? "Saved ✓" : "Save look");
  const checkBtn = h("button", { class: "btn accent small", onclick: async () => {
    checkBtn.disabled = true; checkBtn.textContent = "Checking live listings…";
    try { o.items = (await api(`/outfits/${o.id}/verify`, "POST")).items; drawPieces(); }
    catch (x) { toast(x.message); }
    finally { checkBtn.disabled = false; checkBtn.textContent = "Re-check live prices"; }
  } }, o.items.some((i) => i.verified) ? "Re-check live prices" : "Check live prices");

  function drawPieces() {
    piecesBox.replaceChildren(...o.items.map((it) => {
      const v = it.verified, live = v && v.status !== "not_found";
      const price = live && v.price ? v.price : it.price ? it.price + " (estimate)" : "";
      const meta = it.owned ? ["From your wardrobe", it.color] : [it.brand, it.color, price];
      const direct = v?.status === "verified" && /^https?:\/\//.test(v.url || "");
      return h("div", { class: "piece" },
        h("div", { class: "meta" },
          h("small", {}, it.slot), h("p", {}, h("strong", {}, it.name)), h("small", {}, meta.filter(Boolean).join(" · ")),
          !it.owned && v && h("div", { class: "badges" },
            v.status === "verified" && h("span", { class: "badge good" }, "Verified" + (v.retailer ? " at " + v.retailer : "")),
            v.status === "out_of_stock" && h("span", { class: "badge bad" }, "Out of stock" + (v.retailer ? " at " + v.retailer : "")),
            v.status === "not_found" && h("span", { class: "badge" }, "No live listing found: price is an estimate"),
            live && v.shipping && h("span", { class: "badge" }, "Shipping: " + v.shipping),
            live && v.returns && h("span", { class: "badge" }, "Returns: " + v.returns),
            h("span", { class: "badge" }, "Checked " + timeAgo(v.checked_at))),
          it.note && h("small", {}, it.note)),
        !it.owned && h("a", {
          class: "btn small", target: "_blank", rel: "noopener noreferrer",
          href: direct ? v.url : "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent([it.brand, it.name, it.color].filter(Boolean).join(" ")),
        }, direct ? "Buy now" : "Find it"));
    }));
  }
  drawPieces();
  return h("article", { class: "look" },
    h("span", { class: "tag" }, DIRECTION[o.direction] || "Look"), h("h3", {}, o.title), h("p", {}, o.why_it_works),
    (o.color_note || o.body_note) && h("p", { class: "note" }, [o.color_note, o.body_note].filter(Boolean).join(" ")),
    piecesBox, o.est_total && h("p", { class: "note" }, "New pieces total (estimate): " + o.est_total),
    h("div", { class: "actions" }, saveBtn, checkBtn, h("a", { class: "btn ghost small", href: "#/tryon/" + o.id }, "Try it on")));
}

/* ---- wardrobe + closet photo scan ---- */
async function wardrobeView() {
  if (!state.wardrobe) state.wardrobe = (await api("/wardrobe")).items;
  const list = h("div", { class: "panel" });
  const draw = () => list.replaceChildren(...(state.wardrobe.length
    ? state.wardrobe.map((w) => h("div", { class: "row-item" },
        h("div", {}, h("strong", {}, w.name), h("div", { class: "note" }, [w.category, w.color].filter(Boolean).join(" · "))),
        h("button", { class: "btn ghost small", "aria-label": "Remove " + w.name, onclick: async () => {
          await api("/wardrobe/" + w.id, "DELETE"); state.wardrobe = state.wardrobe.filter((x) => x.id !== w.id); draw();
        } }, "Remove")))
    : [h("p", { class: "empty" }, "Your wardrobe is empty. Add what you own and Atelier will style from it first.")]));
  draw();

  const form = h("form", { class: "panel grid2", onsubmit: async (e) => {
    e.preventDefault();
    try { const d = await api("/wardrobe", "POST", { name: form.name.value, category: form.category.value, color: form.color.value }); state.wardrobe.unshift(d.item); form.reset(); draw(); toast("Added"); }
    catch (x) { toast(x.message); }
  } },
    field("Item", h("input", { name: "name", required: true, placeholder: "Navy linen shirt" })),
    field("Type", h("select", { name: "category" }, ["Top", "Bottom", "Outerwear", "Shoes", "Accessory"].map((c) => h("option", {}, c)))),
    field("Colour", h("input", { name: "color", placeholder: "Navy" })),
    h("div", { class: "end" }, h("button", { class: "btn" }, "Add to wardrobe")));

  const scanOut = h("div", { class: "stack", "aria-live": "polite" });
  const file = h("input", { type: "file", accept: "image/*", class: "sr", id: "closetfile", onchange: async () => {
    const f = file.files[0]; file.value = "";
    if (!f) return;
    scanOut.replaceChildren(h("div", { class: "skeleton" }));
    try {
      const image = await fileToJpeg(f);
      const d = await api("/vision/scan-closet", "POST", { image });
      if (!d.items.length) { scanOut.replaceChildren(h("p", { class: "note" }, "No clothing found. Try a closer, brighter photo.")); return; }
      const boxes = d.items.map((it, n) => ({ it, box: h("input", { type: "checkbox", checked: true, id: "sc" + n }) }));
      scanOut.replaceChildren(
        d.demo && h("p", { class: "err" }, "Demo mode: sample results. Add an API key to scan real photos."),
        h("p", { class: "label" }, "Found " + d.items.length + " items. Untick anything wrong, then add."),
        ...boxes.map(({ it, box }, n) => h("label", { class: "check", for: "sc" + n }, box, h("span", {}, `${it.name} (${[it.category, it.color].filter(Boolean).join(", ")})`))),
        h("button", { class: "btn", onclick: async () => {
          const chosen = boxes.filter((b) => b.box.checked).map((b) => b.it);
          if (!chosen.length) return;
          try { const r = await api("/wardrobe/bulk", "POST", { items: chosen }); state.wardrobe.unshift(...r.items.reverse()); draw(); scanOut.replaceChildren(); toast(r.items.length + " items added"); }
          catch (x) { toast(x.message); }
        } }, "Add selected to wardrobe"));
    } catch (x) { scanOut.replaceChildren(h("p", { class: "err", role: "alert" }, x.message)); }
  } });
  const scan = h("div", { class: "panel stack" }, h("h3", {}, "Scan a photo of your closet"),
    h("p", { class: "note" }, "Take or upload one photo. AI lists what it sees and you confirm. The photo is analysed and then discarded; it is never stored."),
    file, h("label", { class: "btn ghost", for: "closetfile", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } } }, "Take or choose a photo"), scanOut);

  return h("div", {}, h("div", { class: "head" }, h("h2", {}, "Your wardrobe")), scan, h("div", { class: "spacer" }), form, h("div", { class: "spacer" }), list);
}

/* ---- camera try-on ---- */
async function tryonView(preId) {
  const { outfits } = await api("/outfits?recent=1");
  if (!outfits.length) return h("div", {}, h("div", { class: "head" }, h("h2", {}, "Try it on")), h("p", { class: "empty" }, "Create a look first, then come back to try it on."), h("div", { class: "actions" }, h("a", { class: "btn", href: "#/create" }, "Create a look")));
  let current = outfits.find((o) => o.id === preId) || outfits[0];
  const frame = h("div", { class: "cam" });
  const result = h("div", { class: "stack", "aria-live": "polite" });
  const select = h("select", { id: "lookpick", onchange: () => { current = outfits.find((o) => o.id === select.value); stopCamera(); showIdle(); } },
    outfits.map((o) => h("option", { value: o.id, selected: o.id === current.id }, `${o.title} (${DIRECTION[o.direction] || "look"})`)));
  const chips = () => h("div", { class: "chips" }, current.items.map((i) => h("span", {}, `${i.slot}: ${[i.color, i.name].filter(Boolean).join(" ")}`)));
  const uploadInput = h("input", { type: "file", accept: "image/*", class: "sr", id: "tryfile", onchange: async () => {
    const f = uploadInput.files[0]; uploadInput.value = "";
    if (f) { try { analyse(await fileToJpeg(f)); } catch (x) { toast(x.message); } }
  } });
  const uploadLabel = h("label", { class: "btn ghost", for: "tryfile", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); uploadInput.click(); } } }, "Upload a photo instead");
  const controls = h("div", { class: "actions" });

  function showIdle() {
    frame.replaceChildren(h("div", { class: "empty cam-empty" }, "Stand back so your full outfit is in frame, in good light."));
    controls.replaceChildren(h("button", { class: "btn", onclick: startCamera }, "Start camera"), uploadLabel);
    result.replaceChildren();
  }
  async function startCamera() {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 } }, audio: false });
    } catch {
      toast("Camera unavailable or blocked. You can upload a photo instead.");
      return;
    }
    const video = h("video", { autoplay: true, playsinline: true, muted: true, "aria-label": "Live camera preview" });
    video.srcObject = state.stream;
    frame.replaceChildren(video, chips());
    controls.replaceChildren(
      h("button", { class: "btn", onclick: () => { const img = toJpeg(video); stopCamera(); analyse(img); } }, "Capture and check fit"),
      h("button", { class: "btn ghost", onclick: () => { stopCamera(); showIdle(); } }, "Stop camera"));
  }
  async function analyse(img) {
    frame.replaceChildren(h("img", { src: img, alt: "Your photo" }), chips());
    controls.replaceChildren(h("button", { class: "btn ghost", onclick: startCamera }, "Retake"), uploadLabel);
    result.replaceChildren(h("div", { class: "skeleton" }));
    try {
      const d = await api("/vision/tryon", "POST", { image: img, outfit_id: current.id });
      const f = d.feedback;
      result.replaceChildren(
        d.demo && h("p", { class: "err" }, "Demo mode: sample feedback. Add an API key for a real fit check."),
        h("div", { class: "panel stack" },
          h("p", {}, h("span", { class: "score" }, f.score), h("span", { class: "note" }, " / 100 fit for you")), h("p", {}, f.summary),
          f.works.length > 0 && h("div", {}, h("p", { class: "label" }, "What works"), h("ul", {}, f.works.map((w) => h("li", {}, w)))),
          f.tweaks.length > 0 && h("div", {}, h("p", { class: "label" }, "Try this"), h("ul", {}, f.tweaks.map((w) => h("li", {}, w)))),
          h("p", { class: "hint" }, "Your photo was analysed and discarded. It was not saved.")));
    } catch (x) { result.replaceChildren(h("p", { class: "err", role: "alert" }, x.message)); }
  }
  showIdle();
  return h("div", {}, h("div", { class: "head" }, h("h2", {}, "Try it on")),
    h("div", { class: "cols" },
      h("div", { class: "stack" }, field("Look to try", select), frame, controls, h("p", { class: "hint" }, "Your camera is used only while it is on. The photo you capture is sent to AI for a fit check, then discarded.")),
      result));
}

async function savedView() {
  const { outfits } = await api("/outfits");
  return h("div", {}, h("div", { class: "head" }, h("h2", {}, "Saved looks")),
    outfits.length ? h("div", { class: "looks" }, outfits.map((o) => lookCard(o))) : h("p", { class: "empty" }, "Nothing saved yet. Create a look and tap Save look."));
}

/* ---------- router ---------- */
async function render() {
  stopCamera();
  renderBar();
  const [route, param] = location.hash.replace("#/", "").split("/");
  const guarded = ["create", "wardrobe", "saved", "profile", "tryon"];
  if (guarded.includes(route) && !state.user) { location.hash = "#/login"; return; }
  if (["login", "signup", "forgot"].includes(route) && state.user) { location.hash = "#/create"; return; }
  let view;
  try {
    view = route === "login" ? authView("login") : route === "signup" ? authView("signup") : route === "forgot" ? forgotView()
      : route === "reset" ? resetView(param || "") : route === "profile" ? profileView() : route === "create" ? createView()
      : route === "wardrobe" ? await wardrobeView() : route === "saved" ? await savedView() : route === "tryon" ? await tryonView(param) : landing();
  } catch (x) { view = h("p", { class: "err", role: "alert" }, x.message); }
  $app.replaceChildren(view);
  document.title = "Atelier — " + (route || "your personal stylist");
  window.scrollTo(0, 0);
  $app.focus({ preventScroll: true });
}

async function boot() {
  if (state.token) { try { state.user = (await api("/me")).user; } catch { state.token = null; } }
  addEventListener("hashchange", render);
  render();
}
boot();
