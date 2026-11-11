# TRN: trn.geocornr.com

Node + Express + socket.io. Clerk sign-in (Google), live WebRTC screens, emails, recordings.

## 1. Sign-in with Clerk (Google login included)
1. Sign up at https://clerk.com and **Create application**. Turn on **Google** under sign-in options (email is fine too).
2. Open **Configure → API keys** and copy the **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`).
3. That's all for testing. In a Clerk *development* instance, Google works with Clerk's shared credentials, so you do not need Google Cloud.
4. **Going public later:** switch the Clerk app to its **Production** instance. Clerk will ask you to (a) add a few DNS records for your domain and (b) create your own Google OAuth credentials once. Clerk shows step-by-step guides for both. Production keys start with `pk_live_` / `sk_live_`.

## 2. Deploy on Render
1. Push this folder to GitHub.
2. Render → **New → Web Service** → pick the repo. Build command `npm install`, start command `npm start`.
3. Environment variables:
   | Name | Value |
   |---|---|
   | `CLERK_PUBLISHABLE_KEY` | `pk_test_...` from Clerk |
   | `CLERK_SECRET_KEY` | `sk_test_...` from Clerk (keep private) |
   | `PUBLIC_URL` | `https://trn.geocornr.com` |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | email provider (Brevo, Resend or Mailgun SMTP have free tiers). Without these, emails are only logged. |
   | `PRE_SECONDS` | `60` (use `10` while testing) |
   | `RECORDINGS_DIR` | `/data/rec` if you add a Render Disk mounted at `/data` |
4. **Custom domain**: Render service → Settings → Custom Domains → add `trn.geocornr.com`, then add a **CNAME** at your DNS provider: name `trn`, value `YOUR-SERVICE.onrender.com`.
5. Use a paid instance. Free instances sleep, and everything is held in memory.

## 3. Run locally
```
npm install
CLERK_PUBLISHABLE_KEY=pk_test_xxx CLERK_SECRET_KEY=sk_test_xxx PRE_SECONDS=10 npm start     # http://localhost:3000
```
Screen sharing works on localhost or HTTPS only.

## Limits to know about
- **State is in memory.** A restart or redeploy wipes live tournaments. Move `comps` to Redis or Postgres when you need durability.
- **WebRTC is peer-to-peer mesh**: each competitor sends their screen to every spectator. Fine for roughly 10 to 20 people. Past that, use an SFU such as LiveKit.
- **Add a TURN server** (Twilio, Metered, or coturn) in `ICE` in `public/index.html`, or some players behind strict NATs will see black tiles.
- **Recordings** are captured in the creator's browser, so the creator's tab must stay open during events. Files vanish on redeploy unless you attach a Render Disk, and are deleted when a tournament ends.
- The creator is not a player. A joiner can only enter before the first event runs.
