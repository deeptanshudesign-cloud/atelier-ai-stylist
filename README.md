# Atelier: personal AI stylist

A complete, launch-ready app: HTML/CSS/JS front end, Node + Express backend, PostgreSQL database, and an AI stylist agent powered by Claude.

## Features
- **Accounts:** email + password (scrypt), signed 30-day tokens, terms acceptance recorded
- **Password reset by email:** one-hour single-use links; changing the password signs out all old sessions
- **Style profile** and **wardrobe manager** (the stylist uses your own clothes first)
- **Closet photo scan:** upload one photo, AI lists the garments, you confirm before anything is added
- **Camera try-on:** live camera preview with the look's pieces shown, capture a photo, get a fit check with score and specific tweaks (or upload a photo instead)
- **Three looks per request** (familiar / elevated / unexpected) with reasons
- **Live listing check:** price, stock, shipping and returns via Claude web search
- **Privacy tools:** download all your data, delete your account (cascades to everything)
- **Privacy Policy and Terms pages** (templates, see below)
- **Real database:** PostgreSQL with indexes and cascading deletes
- Rate limits, CSP and security headers, accessible and responsive UI, dark mode
- **Demo mode** when no API key is set, so the whole flow can be tested for free

Photos from closet scan and try-on are analysed in memory and **never stored**.

## Run locally
```
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY (optional) and APP_SECRET
node --env-file=.env server.js
```
Open http://localhost:3000. With no `DATABASE_URL` it uses embedded PostgreSQL in `./pgdata`. First start takes a few seconds. Without an email provider, reset links are printed in the server log.

## Test
```
node server.js > server.log &       # start the server
SERVER_LOG=server.log node smoke.test.mjs
```
47 checks cover auth, data isolation, wardrobe, looks, closet scan, try-on, password reset, export, deletion and the legal pages.

## Deploy
1. Push to GitHub. Create a Node web service (build `npm install`, start `npm start`) on Render, Railway, Fly.io or a VPS.
2. Create a managed PostgreSQL database (Neon, Supabase, Render, Railway...). Set `DATABASE_URL` (and `PGSSL=require` if needed). Tables are created automatically on first start.
3. Set `APP_SECRET`, `NODE_ENV=production`, `APP_URL`, `TRUST_PROXY=1`, `ANTHROPIC_API_KEY`.
4. Email: create a Resend account, verify your sending domain, set `RESEND_API_KEY` and `MAIL_FROM`.
5. Add your domain. HTTPS comes from the host; camera access requires HTTPS.

## Before you launch: legal pages
`public/privacy.html` and `public/terms.html` describe how this app actually behaves, but they are **templates**. Replace every `[BRACKET]` (company name, contact email, date, hosting/email providers, governing law, minimum age, backup retention) and have a lawyer review them for your country. Search for `[` in both files.

## Scaling notes
- Rate limits are in memory per instance. If you run more than one instance, move them to Redis or a database table.
- Add an index or pagination if a user's wardrobe passes a few hundred items (the cap is 300).
- Back up the database (managed providers do this daily).
- Embedded mode (no `DATABASE_URL`) is for local development and demos only.

## API
`POST /api/auth/signup|login|forgot|reset`, `GET /api/me`, `PUT /api/profile`, `GET /api/account/export`, `DELETE /api/account`,
`GET|POST|DELETE /api/wardrobe` (+ `/bulk`), `POST /api/outfits/generate`, `GET /api/outfits`, `POST /api/outfits/:id/save|verify`,
`POST /api/vision/scan-closet|tryon`, `GET /healthz`
