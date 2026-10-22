# Leak-proof video (Bunny Stream) — setup & verification

Staff upload lesson videos from **inside the portal** (never opening Bunny). Files upload
**browser → Bunny directly** (bytes never touch our server). Students watch via a **signed, expiring**
player with a **moving name+phone watermark**, so a leaked URL is worthless. Admins see usage.
Deleting a recording in the portal **also deletes it from Bunny**.

This was added **alongside** the existing Google Drive playback — old Drive videos keep working; new
file uploads go to Bunny. A recording is "Bunny" when its private `recording_urls.url` = `bunny:<guid>`.

## STEP 1 — Bunny dashboard (do this by hand, once)
In your Bunny **Stream library**:
1. **Security → Embed View Token Authentication: ON.** This is the switch that forces signed embeds.
   It is a *different* toggle from "CDN Token Authentication" — the iframe embed needs the **Embed View** one.
2. **Security → Allowed Referrers:** add
   `reemshataphysics.com`, `www.reemshataphysics.com`, `mrs-reem-shata-physics.vercel.app`, `localhost`.
3. **Encoding:** cap output at **720p**; **disable the MP4 Fallback** rendition (removes an easy download path + saves storage).

Copy these four values (you'll paste 3 into Vercel):
- **Library ID** (numeric) — library → API page → `BUNNY_LIBRARY_ID`
- **API Key** — library → API page → `BUNNY_API_KEY` **(secret)**
- **Token Authentication Key** — library → Security → `BUNNY_TOKEN_KEY` **(secret)**
- CDN Hostname — informational (the player uses `iframe.mediadelivery.net`; thumbnails come from `*.b-cdn.net`).

## STEP 2 — Vercel env vars (Settings → Environment Variables, Production + Preview)
- `BUNNY_LIBRARY_ID` — numeric (not secret)
- `BUNNY_API_KEY` — **Sensitive ON**
- `BUNNY_TOKEN_KEY` — **Sensitive ON**

(`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE` are already set.) Then `vercel --prod`.

## What runs where
- `api/video-upload.js` — **staff only**. Creates the Bunny video, returns TUS credentials (never the API key).
- `api/rec.js` (existing play gate) — now also signs Bunny embeds: after the access check, if the ref is
  `bunny:<guid>` it returns a **6-hour signed** `iframe.mediadelivery.net` URL (`token = sha256(TOKEN_KEY+guid+expires)`).
- `api/video-stats.js` — **admin only** (assistants get 403). Storage / views / watch time / per-video.
- `api/video-delete.js` — **staff only**. Deletes from Bunny (best-effort) + all DB rows, tenant-scoped.
- `lib/bunny.js` — shared server helpers (JWT verify + role/tenant gate; keys read from env only).
- Client: file-upload in the Recordings pane (TUS via `tus-js-client`), the Bunny iframe player with the
  moving watermark, and the admin-only **Video Usage** dashboard.

## VERIFY (proven vs. needs-the-live-site)

**Proven now (in this codebase):**
1. ✅ **No keys in the client.** `grep -i "BUNNY_API_KEY|BUNNY_TOKEN_KEY|AccessKey" index.html` → nothing.
   The keys appear **only** as `process.env.*` in `lib/bunny.js` / the `api/*` functions. There is no bundler —
   `index.html` is served as-is — so nothing can leak them into a browser payload.
2. ✅ **Unauthorized student is rejected server-side.** `/api/rec` runs `shata_recording_access` **as the caller**
   and, if it returns false, replies `403 no_access` and signs nothing — the sign only happens *after* the check.
3. ✅ **Assistant cannot reach usage.** `api/video-stats.js` calls `requireRole(['admin'])`; role `assist` → `403`.
4. ✅ **Bytes never pass through us.** Upload is TUS browser→Bunny; no function handles the video body.
5. ✅ **The playback URL is signed + time-bounded** (sha256 token + a 6-hour `expires`) — see the Bunny branch in `api/rec.js`.

**Can only be confirmed on the LIVE site (I can't — needs your Bunny library + a deploy):**
6. ⚠️ **No-token embed shows Bunny's 403.** Load an embed URL *without* `?token=...` in a real browser — it should
   show Bunny's error. This depends on **Embed View Token Authentication being ON** (Step 1.1). The iframe HTML shell
   returns HTTP 200 with or without a token, so test playback **visually**, not by curl status code.
7. ⚠️ **A 90-minute video plays start-to-finish.** The token window is **6 hours**, so it won't expire mid-play —
   confirm by watching one through on the live site after upload + ~1 min Bunny processing.

These two are correct in code but I can't exercise them: they require you to create the Bunny library, flip the
Embed-View toggle, set the 3 secrets, deploy, and upload a test file. Do that, then verify 6 and 7 visually.

## Note
Uploading one file fanned out to multiple schools (e.g. "Private — Both Groups") creates multiple metadata rows
sharing one Bunny `guid`; deleting any one of them deletes the shared Bunny video. For most (single-school)
uploads this never applies. Bunny is a paid service (storage + bandwidth) — this is the paid, truly-leak-proof
route, replacing Drive only for new uploads.
