# Interview Coach

AI-powered mock behavioral interview coach. Speak naturally — the coach asks questions, listens, follows up, and scores your answers in real time.

Built with Next.js + AssemblyAI Voice Agent API.

---

## Local development

**1. Get an API key**

Create one at <https://www.assemblyai.com/dashboard/api-keys>.

**2. Set the environment variable**

```bash
cp .env.local.example .env.local
# edit .env.local and paste your key as ASSEMBLYAI_API_KEY=...
```

**3. Install and run**

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, click **Start Session**, and allow microphone access.

> Mic access requires a secure origin. `localhost` counts as secure, so `npm run dev` works fine.
> On a deployed URL, Vercel provides HTTPS automatically.

---

## Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel            # follow the prompts
```

Then add the environment variable in the Vercel dashboard:
**Project → Settings → Environment Variables → Add**

| Name | Value |
|---|---|
| `ASSEMBLYAI_API_KEY` | `your_key_here` |

Redeploy (or trigger via `vercel --prod`) and the app is live.

---

## How it works

| Layer | What it does |
|---|---|
| `GET /api/token` | Server route — mints a short-lived AssemblyAI session token using the secret API key. The key never leaves the server. |
| `wss://agents.assemblyai.com/v1/ws?token=…` | Voice Agent WebSocket — full-duplex: mic audio in, agent audio out, transcripts, and tool calls. |
| `public/worklet.js` | AudioWorklet — resamples mic to 24 kHz (handles Safari's 48 kHz default), converts Float32 → PCM16, posts 50 ms chunks. |
| `app/page.tsx` | All client logic: token fetch, WebSocket lifecycle, gapless playback queue, transcript display, feedback scores. |

The `save_feedback` tool is called by the agent after each answer; results surface as score cards on the right panel.
