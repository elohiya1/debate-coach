# ⚔️ Debate Coach

An AI-powered voice debate coach that argues back, detects logical fallacies in real time, and scores your performance when the round ends.

**Tech stack:** Next.js · TypeScript · Tailwind CSS · AssemblyAI Streaming STT · Claude on AWS Bedrock

---

## How it works

1. Pick a debate topic, choose your side (for/against), and set difficulty
2. Speak your argument — AssemblyAI transcribes your speech live
3. Claude argues the opposite side and responds via text-to-speech
4. After each turn, a parallel Claude call checks your statement for logical fallacies (strawman, false dichotomy, ad hominem, slippery slope, appeal to authority)
5. Click **End & Score** — Claude reads the full transcript and returns a structured performance review across 4 categories

---

## Local setup

**1. Clone and install**

```bash
git clone https://github.com/elohiya1/debate-coach.git
cd debate-coach
npm install
```

**2. Set environment variables**

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

| Variable | Where to get it |
|---|---|
| `ASSEMBLYAI_API_KEY` | [assemblyai.com/dashboard/api-keys](https://www.assemblyai.com/dashboard/api-keys) |
| `AWS_ACCESS_KEY_ID` | AWS IAM — needs `bedrock:InvokeModel` permission |
| `AWS_SECRET_ACCESS_KEY` | Same IAM user |
| `AWS_REGION` | Your Bedrock-enabled region (e.g. `us-east-1`) |

> **Bedrock model:** defaults to `us.anthropic.claude-sonnet-4-20250514-v1:0`. Override with `BEDROCK_MODEL_ID` if needed. Make sure the model is enabled in your AWS account under **Bedrock → Model access**.

**3. Run**

```bash
npm run dev
# open http://localhost:3000
```

Mic access requires a secure origin. `localhost` qualifies — no extra setup needed for dev.

---

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Add all four environment variables in **Vercel → Project → Settings → Environment Variables**, then:

```bash
vercel --prod
```

HTTPS is provided automatically — mic access works out of the box.

---

## Architecture

```
Browser
  └── AudioWorklet (16 kHz PCM16)
        └── AssemblyAI Streaming STT WebSocket
              └── Turn events (end_of_turn) → /api/debate (streaming)
                                             → /api/fallacy (parallel)
              └── End & Score              → /api/score

/api/debate   — streams Claude response via Bedrock InvokeModelWithResponseStream
/api/fallacy  — single Bedrock call, returns { fallacy, explanation }
/api/score    — single Bedrock call, returns structured rubric JSON
/api/aai-token — mints a short-lived AssemblyAI streaming token (key stays server-side)
```

**Note on TTS:** Claude's responses are spoken using the browser's built-in `speechSynthesis` API. AssemblyAI does not offer a standalone TTS product — TTS is only available inside their managed Voice Agent API.
