# Hidden Google Drive Recordings (reusable guide)

How this site serves lesson recordings from Google Drive **without ever exposing the Drive
link to the browser**, with per-student access control, at **zero bandwidth cost**. Written to
be reusable: the same setup works on any website (any subject, any tutor), not just this one.

---

## The idea in one paragraph

Videos stay on Google Drive (free, unlimited-ish, nothing stored on your host). The Drive link
is NOT baked into the page. Instead, when a student presses play, the page asks **your server**
for permission; the server checks the rules and only then hands back the stream URL, which the
browser plays natively straight from Google. A declined student never receives the URL. Google
carries every byte of video, so your host pays no bandwidth.

```
Student presses play
        |
        v
Page asks your server  (student's login attached)
        |
        v
Server checks the rules ----denied----> "No access" message
        |
     allowed
        |
        v
Server returns the stream URL  (only after the access check)
        |
        v
Browser plays it natively, straight from Google  (free, at any scale)
```

> **Why not proxy/redirect the bytes to hide the URL completely?** Two reasons. (1) Piping every
> byte through your host burns bandwidth fast (a 130 MB lesson × many views ≫ Vercel's free
> 100 GB). (2) A `<video>` element pointed at a same-origin URL that 302-redirects to a
> cross-origin file is rejected by browsers' media loaders (especially Safari with byte ranges) —
> so the redirect trick breaks playback. Native direct playback is the reliable, free option, and
> the **access control** (the part that actually matters) is fully server-side either way.

## What a curious student can and cannot see

| Where they look | What they find |
|---|---|
| The static page / view-source | **No Drive link** — it isn't in the HTML; it's fetched only after an access-checked click |
| A student whose request was declined | Gets nothing — the server refuses to return the URL |
| DevTools open *during* playback | Can read the stream URL (the accepted "extra step" limit) |
| Full hiding needed? | Turn on `proxy` mode below (costs bandwidth) |

## Two modes (`REC_MODE` env var)

- **`direct` (default)** — after the access check, the server returns the stream URL and the
  browser plays it natively from Google. Zero host bandwidth, plays reliably on every device
  (Mac, iPhone, Android). The URL is only obtainable through the access-checked call, but a
  student with DevTools open can read it during playback. Best default for cost + reliability.
- **`proxy`** — the server mints an opaque play pass and pipes the video bytes through itself,
  hiding the URL even from the Network tab. Trade-off: **all video traffic counts against your
  host's data transfer** (Vercel Hobby ≈ 100 GB/mo ≈ a few hundred lesson views; Pro = 1 TB for
  $20/mo). Only flip this on if total secrecy is worth paying for bandwidth.

## How the pieces fit (this repo)

| Piece | File | Job |
|---|---|---|
| Play gate | `api/rec.js` | POST = access check → returns stream URL (direct) or a play pass (proxy). GET = pipe bytes (proxy only) |
| Access rule | DB function `shata_recording_access(uuid)` | Answers ONLY true/false — the URL is never returned by a DB function a student can call |
| Link storage | DB table `recording_urls` | Private (RLS, no policies) — readable by the server's service role only |
| Player | `index.html` (`stuPlayVideo` → `openVideo`) | POSTs for access, plays the returned URL as a native `<video>` (with a Google `/preview` iframe fallback) |

Access rules enforced by the DB function (this site): staff always; student's school/level must
match the video; "Espresso" lessons open to all matching students; Private-group students play
instantly; everyone else needs an approved request.

## Setting this up on another website

1. **Store links privately.** A table like `recording_urls (client_id, video_id, url)` with RLS
   enabled and NO policies — only the service-role key (server) can read it. Never put the URL
   in a table the browser can select from.
2. **Write a boolean access function.** A `SECURITY DEFINER` Postgres function that takes a
   video id, applies YOUR access rules for `auth.uid()`, and returns **true/false only**.
   (Returning the URL from a function callable by signed-in users is the classic mistake — a
   student can call it from the browser console and share the permanent link.)
3. **Copy `api/rec.js`** (Vercel-native). Adjust `SITE_CLIENT_ID`, the RPC name, and rules.
   It needs: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, and optionally `REC_SIGNING_SECRET`
   (any long random string; falls back to the service key) and `REC_MODE`.
4. **Client:** on play, POST `{video_id}` to `/api/rec` with the user's auth token; play the
   returned `src` in a `<video>` tag. Non-Drive sources (e.g. YouTube) come back unchanged —
   embed them normally.
5. **Drive files** must be shared "Anyone with the link" (viewer). Re-encode phone-unfriendly
   videos to H.264 MP4 (~720p) so iPhones play them smoothly.

## Caveats

- **Local preview cannot play recordings** — there's no server locally. Test on the deployed
  site (`vercel --prod`).
- If Drive rate-limits a very popular file ("quota exceeded"), playback pauses for everyone
  until Google resets it — rare at classroom scale.
- Seed/placeholder rows with fake Drive IDs can never play. On this site, "Mechanics — Lesson 1"
  and "Waves — Lesson 1" are seeds — delete them from the admin panel.

---

## Task checklist — what was asked and what was done (July 9, 2026)

- [x] **Keep the Drive link out of the static page** — it's no longer baked into the HTML; the
  browser only receives a stream URL after an access-checked POST. A declined student gets
  nothing. (Full Network-tab hiding is available via `REC_MODE=proxy`, at a bandwidth cost.)
- [x] **Middle-layer server script, Drive stays the permanent source** — `api/rec.js` gate +
  Drive as stable no-expiry storage; nothing stored on Vercel.
- [x] **No bandwidth cost through Vercel** — default `direct` mode: the browser streams straight
  from Google, so no video bytes flow through Vercel. Proxy mode is the opt-in (`REC_MODE=proxy`).
- [x] **Fix recordings not playing (MacBook + mobile)** — switched to native direct playback of
  the faststart MP4 (the browser-supported path) with a Google `/preview` iframe fallback, after
  a 302-redirect approach proved to break `<video>` playback. Note: 2 of the 4 listed recordings
  are fake seed placeholders that can never play — test with the real ones and delete the seeds.
- [x] **Access rules preserved** — Espresso open, private instant, schools by approval, staff
  always; declined students blocked server-side.
- [x] **Request-access RLS bug fixed** — the "Request access" button was failing with a
  row-level-security error when a student's login token had silently expired; it now refreshes
  the session and uses the session's own id, with an automatic retry.
- [x] **Security review passed** — a 16-agent adversarial review raised 12 findings, 10
  confirmed, all fixed (biggest: a leftover DB function that leaked the raw URL to any signed-in
  student's console — now returns true/false only).
