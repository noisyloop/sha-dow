# sha-dow

An experimental, free, 24-hour public chat. Your handle is an emoji, every post is shown as binary, and everything is deleted after 24 hours.

It's styled like an old-school imageboard: a pale green board, a `/01/` header, a table-style post form (no attachments, ever), and reply boxes with post numbers. It works on mobile, and there's a dark variant that follows your system setting.

```
>> 🦊 Anonymous 10/16/26(Fri)09:45:48 No.2 [burns in 24h]
     01100111 01101101 00100000 01100101 01110110 01100101 01110010 01111001
```

## Deploy on Vercel

1. Import the GitHub repo in Vercel. `vercel.json` already sets the build (`npm run build`), the output folder (`dist`), the API function and the security headers.
2. In the project, open **Storage → Create Database → Redis** (Upstash, free plan) and connect it to the project. No separate Upstash account is needed: Vercel creates it and adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project for you.
3. Redeploy so the function picks up the new settings.

Without step 2 the site loads, but the chat says "Storage not set up" instead of crashing.

## Run it locally

```bash
npm install
npm start          # builds dist/ (minified + scrambled), serves it on http://localhost:3000
npm run dev        # serves the readable sources in public/ (for development)
npm test           # rules, store and API tests
```

Locally it uses an in-memory store (wiped on restart), unless the `KV_REST_API_*` variables point at a real Redis.

Environment variables:

| Var | Default | Meaning |
| --- | --- | --- |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | set by Vercel Storage | Redis REST endpoint and token (`UPSTASH_REDIS_REST_*` also work) |
| `DAILY_LIMIT` | `100` | Posts allowed per rolling 24h, per session **and** per network |
| `ALLOWED_ORIGINS` | same host | Comma-separated origins allowed to post |
| `PORT` | `3000` | Local server port |
| `TRUST_PROXY` | on for Vercel | Read the client IP from proxy headers and send `Secure` cookies |

### How it runs on serverless

Vercel functions can't hold WebSockets or keep memory between requests, so:

- **State lives in Redis**: posts, emoji claims, network locks, quotas and rate limits, all with 24h expiry.
- **Browsers poll** a tiny version number every 3s, or every 15s when idle, and stop while the tab is hidden. That reply is cached by Vercel's CDN for 3s and shared by every visitor, so polling costs at most about one Redis read per 3s no matter how many people are watching. The full feed is fetched only when the version changes.
- New posts show up for others within about 3 seconds.

## How it works

- **Emoji handles.** You pick from a fixed list of 64 emoji, not a free-text emoji field. A fixed list rules out look-alikes, zero-width joiners and invisible characters.
- **One emoji per person.** A handle is locked to a server-issued `HttpOnly; SameSite=Strict` session cookie. Nobody else can take it while you hold it, and it frees up 24h after you were last seen. You can also give it up.
- **One emoji per network.** A second session from the same IP can't claim a different emoji. IPv6 addresses are grouped by /64. IPs are stored only as HMACs, with a random salt that rotates every 24 hours.
- **Always binary.** The client encodes text to 8-bit binary before sending. The server stores and serves only binary. The timeline shows binary. Press and hold a post to decode it on your own screen; letting go shows the binary again.
- **Plain text only.** Allowed: `A–Z a–z 0–9`, space, and `. , ! ? ' ( ) : ;` plus the hyphen. Blocked: `< > & " \` { } [ ] / \ = $ # @ …`, which rules out markup, code, URLs and templates. Pre-encoded binary, hex and base64-looking words, and words longer than 24 characters, are rejected too. Posts are capped at 280 characters.
- **24 hours, then gone.** Every Redis key has a 24h expiry. Posts are removed 24h after they're posted, and handles 24h after you were last seen. The app logs no post content.

### Security measures

| Layer | Measure |
| --- | --- |
| Input | The same `public/shared/rules.js` runs in the browser (instant feedback) and on the server (authority). The server decodes every binary payload and re-checks it. |
| Output | Everything is rendered with `textContent`, never `innerHTML`. |
| Headers | Strict CSP (`script-src 'self'`, no inline script, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP/CORP, HSTS behind TLS. |
| API | Writes need the session cookie, a same-origin `Origin` header and `application/json` (blocks cross-site form posts). Bodies are capped at 4 KB. |
| Abuse | 100 posts per rolling 24h (per session and per IP), burst limits per session and IP, a per-IP request limit, duplicate-post block, 2,000-post cap. |
| Files | Vercel serves only the built `dist/` folder. The server code in `lib/` and `api/` is never served. |

**Honest caveats**

- Binary is an **encoding, not encryption**. Anyone can decode it, and the footer says so.
- IP locks are a deterrent. VPNs and mobile data get around them. Shared networks (a household, school or carrier NAT) get **one emoji between everyone on them**, and share the daily quota too.
- Redis's free plan has a monthly command allowance. Normal use stays well inside it, thanks to the shared cached version check, but a very busy board would need the paid plan (cents per 100k commands).

## Why there's no React, Astro or code hiding

Anything a browser runs can be read with "View source" or DevTools, whatever the framework. React or Astro would bundle and minify the code, but anyone determined can still read it. Security here comes from the **server**, which doesn't trust the client at all:

- It re-validates every payload, enforces the emoji and network locks, and applies the rate limits.
- Someone who reads, or rewrites, `app.js` still can't post HTML, code, other encodings, a taken emoji, or post number 101 of the day.

The server code (`lib/`, `api/`) is never sent to browsers. Keeping the client code small and readable is a deliberate feature: anyone can check that posts are only encoded, not secretly tracked. `npm start` still minifies and scrambles it (`build.mjs`: esbuild, then javascript-obfuscator), so `dist/app.js` is unreadable at a glance. The obfuscator settings that need `eval` are off, and the build fails if any `eval` or `Function` sneaks in, so the strict CSP stays on. Treat this as cosmetic, not security.

## What we could cook up next

Ideas drawn from [noisyloop/Shadow](https://github.com/noisyloop/Shadow) (X3DH, Double Ratchet, Sealed Sender, Nostr transport):

1. **Encrypted 1:1 "shadow rooms"**. Tap an emoji, open a DM, and run X3DH and the Double Ratchet in the browser with `@noble/curves`, ported from `Shadow/mobile/src/crypto`. The server only ever relays ciphertext, and the ciphertext is shown as binary too, so it looks the same as the public feed but is actually unreadable.
2. **Sealed sender for DMs**, so even the relay can't see who's talking to whom.
3. **Invite-code rooms.** In the spirit of zyberg, a room *is* a code: the code derives the room key with HKDF, and anyone with the code can read the room while the server can't.
4. **Nostr transport**, which needs no server to keep alive. Posts become ephemeral Nostr events with an expiration tag (NIP-40) set to 24h.
5. **Stronger anti-abuse.** Proof-of-work per post (hashcash), Cloudflare Turnstile on claiming a handle, and a report button that hides a post after N distinct reports.
6. **Fun mode toggles.** Hex, Morse or Braille views; a "no peek" hardcore mode where you have to decode in your head.

## Disclaimer

This is an experimental chat provided as-is, with no warranty. All applicable laws apply to everything posted. See the footer of the app.
