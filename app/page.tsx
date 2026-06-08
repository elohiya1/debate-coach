'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScoreResult } from './api/score/route';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPICS = [
  'AI will do more harm than good',
  'Social media has a net negative effect on society',
  'Universal Basic Income should be implemented',
  'Space exploration should be prioritized over ocean exploration',
  'Remote work is better than office work',
  'Cryptocurrencies should replace traditional banking',
];

const DIFFICULTY = {
  beginner:     { label: 'Beginner',     description: 'Gentle arguments, occasional concessions' },
  intermediate: { label: 'Intermediate', description: 'Balanced, challenges weak reasoning' },
  expert:       { label: 'Expert',       description: 'Relentless, exposes every flaw' },
} as const;
type Difficulty = keyof typeof DIFFICULTY;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase     = 'setup' | 'debate' | 'scoring' | 'results';
type TurnState = 'idle' | 'listening' | 'processing' | 'speaking';

interface Message {
  id: number;
  role: 'user' | 'ai';
  text: string;
  fallacy?: { name: string; explanation: string } | null;
  fallacyLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(topic: string, userSide: 'for' | 'against', difficulty: Difficulty) {
  const aiSide = userSide === 'for' ? 'against' : 'for';
  const style: Record<Difficulty, string> = {
    beginner:
      'Argue at a high-school level. Make reasonable points but leave some gaps. ' +
      'Occasionally make minor concessions when the human makes a good point.',
    intermediate:
      'Argue firmly and challenge weak reasoning with specific counterpoints. ' +
      'Remain collegial but never concede without good reason.',
    expert:
      'Argue relentlessly using sophisticated logic, statistics, and precedent. ' +
      'Expose every logical gap and never concede ground without overwhelming evidence. ' +
      'Be pointed and aggressive but never personally rude.',
  };

  return (
    `You are a debate opponent arguing ${aiSide} the proposition: "${topic}".\n` +
    `${style[difficulty]}\n` +
    `Rules:\n` +
    `- Keep every response to 2–4 sentences MAX. This is a spoken debate.\n` +
    `- Counter the human's most recent argument directly and specifically.\n` +
    `- Never break character or acknowledge being an AI.\n` +
    `- Never use bullet points or markdown — speak in natural sentences.`
  );
}

function transcriptText(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`)
    .join('\n');
}

// Browser TTS — simple wrapper around speechSynthesis
function speak(text: string, onDone: () => void): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) { onDone(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate  = 1.05;
  utt.pitch = 1.0;
  // Prefer a natural-sounding voice if available
  const voices  = window.speechSynthesis.getVoices();
  const natural = voices.find(
    (v) =>
      v.lang.startsWith('en') &&
      (v.name.includes('Samantha') ||
        v.name.includes('Karen') ||
        v.name.includes('Google') ||
        v.name.includes('Natural')),
  );
  if (natural) utt.voice = natural;
  utt.onend   = () => onDone();
  utt.onerror = () => onDone();
  window.speechSynthesis.speak(utt);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScoreCard({
  label,
  score,
  feedback,
}: {
  label: string;
  score: number;
  feedback: string;
}) {
  const pct = (score / 10) * 100;
  const color =
    score >= 8 ? 'bg-emerald-500' : score >= 6 ? 'bg-violet-500' : score >= 4 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="bg-white rounded-2xl border border-violet-100 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <span className="text-lg font-bold text-slate-900">{score}<span className="text-slate-400 text-sm font-normal">/10</span></span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full mb-2">
        <div className={`h-1.5 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-slate-500 leading-snug">{feedback}</p>
    </div>
  );
}

function FallacyBadge({ name, explanation }: { name: string; explanation: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 border border-amber-300 text-amber-700 text-[10px] font-semibold hover:bg-amber-200 transition-colors mt-1"
    >
      ⚠ {name}
      {open && (
        <span className="font-normal text-amber-600 ml-1">— {explanation}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Page() {
  // ── Setup state
  const [topic,      setTopic]      = useState(TOPICS[0]);
  const [userSide,   setUserSide]   = useState<'for' | 'against'>('for');
  const [difficulty, setDifficulty] = useState<Difficulty>('intermediate');

  // ── App state
  const [phase,          setPhase]          = useState<Phase>('setup');
  const [turnState,      setTurnState]      = useState<TurnState>('idle');
  const [messages,       setMessages]       = useState<Message[]>([]);
  const [partialText,    setPartialText]    = useState('');
  const [streamingAiText, setStreamingAiText] = useState('');
  const [scores,         setScores]         = useState<ScoreResult | null>(null);
  const [errorMsg,       setErrorMsg]       = useState('');

  // ── Stable refs
  const sttWsRef          = useRef<WebSocket | null>(null);
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const sessionActiveRef  = useRef(false);   // STT session open
  const suppressAudioRef  = useRef(false);   // true while AI is speaking
  const historyRef        = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const userStatementsRef = useRef<string[]>([]);
  const systemPromptRef   = useRef('');
  const msgIdRef          = useRef(0);
  const transcriptRef     = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    transcriptRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingAiText]);

  // ---------------------------------------------------------------------------
  // Fallacy detection — fire-and-forget, updates the message after it resolves
  // ---------------------------------------------------------------------------
  const checkFallacy = useCallback(async (msgId: number, statement: string) => {
    try {
      const res = await fetch('/api/fallacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement,
          priorStatements: userStatementsRef.current.slice(0, -1), // exclude current
        }),
      });
      const data = (await res.json()) as { fallacy: string | null; explanation: string | null };
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, fallacyLoading: false, fallacy: data.fallacy ? { name: data.fallacy, explanation: data.explanation ?? '' } : null }
            : m,
        ),
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, fallacyLoading: false } : m)),
      );
    }
  }, []);

  // ---------------------------------------------------------------------------
  // AI turn: call Bedrock, stream response, speak it, then re-enable mic
  // ---------------------------------------------------------------------------
  const handleUserTurn = useCallback(
    async (userText: string) => {
      if (!userText.trim()) return;

      const userMsgId = msgIdRef.current++;
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: 'user', text: userText, fallacyLoading: true },
      ]);
      userStatementsRef.current.push(userText);
      historyRef.current.push({ role: 'user', content: userText });

      // Kick off fallacy check in parallel — non-blocking
      checkFallacy(userMsgId, userText);

      setTurnState('processing');
      suppressAudioRef.current = true;

      try {
        // Stream Claude's response
        const res = await fetch('/api/debate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: historyRef.current,
            system:   systemPromptRef.current,
          }),
        });

        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let fullText  = '';

        setTurnState('speaking');
        setStreamingAiText('');

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });
          setStreamingAiText(fullText);
        }

        // Commit AI message
        const aiMsgId = msgIdRef.current++;
        setMessages((prev) => [...prev, { id: aiMsgId, role: 'ai', text: fullText }]);
        setStreamingAiText('');
        historyRef.current.push({ role: 'assistant', content: fullText });

        // Speak via browser TTS, then re-enable mic
        speak(fullText, () => {
          suppressAudioRef.current = false;
          setTurnState('listening');
        });
      } catch (err) {
        console.error('Debate call failed:', err);
        setErrorMsg('Failed to get AI response. Check AWS Bedrock credentials.');
        suppressAudioRef.current = false;
        setTurnState('listening');
      }
    },
    [checkFallacy],
  );

  // ---------------------------------------------------------------------------
  // Start debate
  // ---------------------------------------------------------------------------
  const startDebate = useCallback(async () => {
    setErrorMsg('');
    setMessages([]);
    setPartialText('');
    setStreamingAiText('');
    setScores(null);
    historyRef.current        = [];
    userStatementsRef.current = [];
    systemPromptRef.current   = buildSystemPrompt(topic, userSide, difficulty);
    msgIdRef.current          = 0;

    setPhase('debate');
    setTurnState('idle');

    try {
      // Mint STT token (no Bearer prefix for streaming STT)
      const tokenRes = await fetch('/api/aai-token');
      if (!tokenRes.ok) throw new Error('Failed to get AssemblyAI token');
      const { token } = (await tokenRes.json()) as { token: string };

      // AudioContext at 16 kHz (STT target)
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('/worklet.js');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const source     = audioCtx.createMediaStreamSource(stream);
      const worklet    = new AudioWorkletNode(audioCtx, 'pcm-processor', {
        processorOptions: { targetSampleRate: 16000 },
      });
      source.connect(worklet);

      // AssemblyAI Streaming STT WebSocket
      // Sends raw binary PCM16 frames; receives JSON Turn events
      const ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=u3-rt-pro&token=${token}`,
      );
      sttWsRef.current = ws;

      ws.onopen = () => {
        sessionActiveRef.current = true;
        setTurnState('listening');
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            transcript?: string;
            end_of_turn?: boolean;
          };

          if (msg.type === 'Turn') {
            if (msg.end_of_turn) {
              // Finalized — trigger AI response
              setPartialText('');
              if (msg.transcript?.trim()) handleUserTurn(msg.transcript);
            } else {
              // Partial — show live
              setPartialText(msg.transcript ?? '');
            }
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onclose = () => {
        sessionActiveRef.current = false;
      };

      ws.onerror = () => {
        setErrorMsg('STT WebSocket error. Check ASSEMBLYAI_API_KEY.');
      };

      // Forward mic audio as raw binary (NOT base64 — streaming STT takes binary frames)
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!sessionActiveRef.current) return;
        if (suppressAudioRef.current) return; // don't send while AI is speaking
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };

      // Opening message from AI coach
      setTurnState('speaking');
      suppressAudioRef.current = true;
      const openingMsg =
        `Welcome to the debate. The topic is: "${topic}". You will argue ${userSide} this proposition. I will argue ${userSide === 'for' ? 'against' : 'for'} it. Make your opening statement.`;
      const aiOpeningId = msgIdRef.current++;
      setMessages([{ id: aiOpeningId, role: 'ai', text: openingMsg }]);
      speak(openingMsg, () => {
        suppressAudioRef.current = false;
        setTurnState('listening');
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('setup');
    }
  }, [topic, userSide, difficulty, handleUserTurn]);

  // ---------------------------------------------------------------------------
  // End debate
  // ---------------------------------------------------------------------------
  const endDebate = useCallback(async () => {
    window.speechSynthesis?.cancel();
    suppressAudioRef.current  = false;
    sessionActiveRef.current  = false;

    if (sttWsRef.current?.readyState === WebSocket.OPEN) {
      sttWsRef.current.send(JSON.stringify({ type: 'Terminate' }));
      sttWsRef.current.close();
    }
    sttWsRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;

    setPhase('scoring');
    setTurnState('idle');

    try {
      const res = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: transcriptText(messages),
          topic,
          userSide: userSide === 'for' ? `FOR: "${topic}"` : `AGAINST: "${topic}"`,
        }),
      });
      const data = (await res.json()) as ScoreResult;
      setScores(data);
      setPhase('results');
    } catch {
      setErrorMsg('Scoring failed. Check AWS credentials.');
      setPhase('results');
    }
  }, [messages, topic, userSide]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const statusConfig: Record<TurnState, { label: string; color: string; pulse: boolean }> = {
    idle:       { label: 'Getting ready…', color: 'bg-slate-400',   pulse: false },
    listening:  { label: 'Listening',       color: 'bg-emerald-500', pulse: true  },
    processing: { label: 'Thinking',        color: 'bg-violet-500',  pulse: true  },
    speaking:   { label: 'AI Speaking',     color: 'bg-blue-500',    pulse: true  },
  };
  const statusInfo = statusConfig[turnState];

  // ---------------------------------------------------------------------------
  // SETUP SCREEN
  // ---------------------------------------------------------------------------
  if (phase === 'setup') {
    return (
      <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-slate-100 flex flex-col font-sans">
        <header className="bg-white/80 backdrop-blur border-b border-violet-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-white text-lg shadow-sm">⚔️</div>
            <div>
              <h1 className="font-bold text-slate-900">Debate Coach</h1>
              <p className="text-violet-400 text-xs">AssemblyAI STT · Claude on Bedrock</p>
            </div>
          </div>
        </header>

        <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-10 flex flex-col gap-8">
          {/* Topic */}
          <section>
            <h2 className="font-semibold text-slate-800 mb-3">Choose a topic</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {TOPICS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTopic(t)}
                  className={`text-left px-4 py-3 rounded-xl border-2 text-sm transition-all ${
                    topic === t
                      ? 'border-violet-500 bg-violet-50 font-semibold text-violet-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-violet-300 hover:bg-violet-50/50'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </section>

          {/* Side */}
          <section>
            <h2 className="font-semibold text-slate-800 mb-3">Your side</h2>
            <div className="flex gap-3">
              {(['for', 'against'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setUserSide(s)}
                  className={`flex-1 py-3 rounded-xl border-2 font-semibold text-sm capitalize transition-all ${
                    userSide === s
                      ? s === 'for'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                        : 'border-rose-500 bg-rose-50 text-rose-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300'
                  }`}
                >
                  {s === 'for' ? '👍 For' : '👎 Against'}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-2">
              You argue <strong>{userSide}</strong> the proposition. AI argues <strong>{userSide === 'for' ? 'against' : 'for'}</strong> it.
            </p>
          </section>

          {/* Difficulty */}
          <section>
            <h2 className="font-semibold text-slate-800 mb-3">Difficulty</h2>
            <div className="flex gap-3">
              {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDifficulty(d)}
                  className={`flex-1 py-3 px-2 rounded-xl border-2 text-sm transition-all ${
                    difficulty === d
                      ? 'border-violet-500 bg-violet-50 text-violet-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300'
                  }`}
                >
                  <div className="font-semibold">{DIFFICULTY[d].label}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 leading-tight hidden sm:block">
                    {DIFFICULTY[d].description}
                  </div>
                </button>
              ))}
            </div>
          </section>

          {errorMsg && (
            <p className="text-red-500 text-sm bg-red-50 border border-red-200 rounded-xl px-4 py-2">{errorMsg}</p>
          )}

          <button
            onClick={startDebate}
            className="w-full py-4 bg-violet-600 hover:bg-violet-500 active:scale-[0.99] text-white rounded-2xl font-semibold text-lg transition-all shadow-lg shadow-violet-200"
          >
            Start Debate ⚔️
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // SCORING SCREEN
  // ---------------------------------------------------------------------------
  if (phase === 'scoring') {
    return (
      <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-slate-100 flex items-center justify-center font-sans">
        <div className="text-center flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full border-4 border-violet-200 border-t-violet-600 animate-spin" />
          <p className="text-slate-600 font-medium">Generating your performance review…</p>
          <p className="text-slate-400 text-sm">Claude is reading the full transcript</p>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // RESULTS SCREEN
  // ---------------------------------------------------------------------------
  if (phase === 'results') {
    return (
      <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-slate-100 font-sans">
        <header className="bg-white/80 backdrop-blur border-b border-violet-100 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-white text-lg">⚔️</div>
            <h1 className="font-bold text-slate-900">Debate Results</h1>
          </div>
          <button
            onClick={() => { setPhase('setup'); setMessages([]); }}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-semibold transition-all"
          >
            Debate Again
          </button>
        </header>

        <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
          {/* Topic recap */}
          <div className="bg-white rounded-2xl border border-violet-100 p-4 shadow-sm">
            <p className="text-xs text-violet-500 font-semibold uppercase tracking-widest mb-1">Topic</p>
            <p className="text-slate-800 font-medium">"{topic}"</p>
            <p className="text-xs text-slate-400 mt-1">You argued <strong>{userSide}</strong> · {DIFFICULTY[difficulty].label}</p>
          </div>

          {scores ? (
            <>
              {/* Overall */}
              <div className={`rounded-2xl p-5 text-white shadow-md ${
                scores.overall.score >= 8 ? 'bg-emerald-500' :
                scores.overall.score >= 6 ? 'bg-violet-600' :
                scores.overall.score >= 4 ? 'bg-amber-500' : 'bg-rose-500'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-lg">Overall Score</span>
                  <span className="text-3xl font-black">{scores.overall.score}<span className="text-base font-normal opacity-80">/10</span></span>
                </div>
                <p className="text-white/90 text-sm leading-relaxed">{scores.overall.summary}</p>
              </div>

              {/* Criteria grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ScoreCard label="Argument Strength"   score={scores.argumentStrength.score}   feedback={scores.argumentStrength.feedback}   />
                <ScoreCard label="Logical Consistency" score={scores.logicalConsistency.score} feedback={scores.logicalConsistency.feedback} />
                <ScoreCard label="Use of Evidence"     score={scores.useOfEvidence.score}      feedback={scores.useOfEvidence.feedback}      />
                <ScoreCard label="Rebuttal Quality"    score={scores.rebuttalQuality.score}    feedback={scores.rebuttalQuality.feedback}    />
              </div>
            </>
          ) : (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{errorMsg || 'Scoring unavailable.'}</div>
          )}

          {/* Transcript recap */}
          <section className="bg-white rounded-2xl border border-violet-100 shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-violet-50">
              <span className="text-xs font-semibold text-violet-500 uppercase tracking-widest">Full Transcript</span>
            </div>
            <div className="p-4 flex flex-col gap-2 max-h-64 overflow-y-auto">
              {messages.map((m) => (
                <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                    m.role === 'user' ? 'bg-violet-600 text-white' : 'bg-violet-50 text-slate-700 border border-violet-100'
                  }`}>
                    {m.text}
                    {m.fallacy && <FallacyBadge name={m.fallacy.name} explanation={m.fallacy.explanation} />}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // DEBATE SCREEN
  // ---------------------------------------------------------------------------
  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur border-b border-violet-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-xl bg-violet-600 flex items-center justify-center text-white text-base shrink-0">⚔️</div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-violet-500 font-semibold uppercase tracking-widest">Debating</p>
          <p className="text-sm font-semibold text-slate-800 truncate">"{topic}"</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-semibold uppercase">
            You: {userSide}
          </span>
          <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[10px] font-semibold uppercase">
            AI: {userSide === 'for' ? 'against' : 'for'}
          </span>
          <button
            onClick={endDebate}
            className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl text-xs font-semibold transition-all"
          >
            End &amp; Score
          </button>
        </div>
      </header>

      {/* Status bar */}
      <div className="bg-white border-b border-violet-50 px-4 py-2 flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${statusInfo.color} ${statusInfo.pulse ? 'animate-pulse' : ''}`} />
        <span className="text-xs font-medium text-slate-600">{statusInfo.label}</span>
        {errorMsg && <span className="text-xs text-red-500 ml-2">{errorMsg}</span>}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-2 items-end ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'ai' && (
              <div className="w-7 h-7 rounded-full bg-violet-100 border border-violet-200 flex items-center justify-center text-sm shrink-0">🤖</div>
            )}
            <div className={`max-w-[78%] flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-violet-600 text-white rounded-br-sm shadow-sm'
                  : 'bg-white text-slate-800 border border-violet-100 rounded-bl-sm shadow-sm'
              }`}>
                {m.text}
              </div>
              {/* Fallacy badge */}
              {m.role === 'user' && m.fallacyLoading && (
                <span className="text-[10px] text-slate-400 mt-1 animate-pulse">checking logic…</span>
              )}
              {m.role === 'user' && m.fallacy && (
                <FallacyBadge name={m.fallacy.name} explanation={m.fallacy.explanation} />
              )}
            </div>
            {m.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-sm shrink-0">🧑</div>
            )}
          </div>
        ))}

        {/* Streaming AI response */}
        {streamingAiText && (
          <div className="flex gap-2 items-end justify-start">
            <div className="w-7 h-7 rounded-full bg-violet-100 border border-violet-200 flex items-center justify-center text-sm shrink-0">🤖</div>
            <div className="max-w-[78%] px-4 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-white text-slate-800 border border-violet-100 shadow-sm">
              {streamingAiText}
              <span className="inline-block w-1.5 h-3.5 bg-violet-400 ml-1 animate-pulse rounded-sm" />
            </div>
          </div>
        )}

        {/* Live partial STT */}
        {partialText && !streamingAiText && (
          <div className="flex gap-2 items-end justify-end">
            <div className="max-w-[78%] px-4 py-2.5 rounded-2xl rounded-br-sm text-sm bg-violet-100 text-violet-600 border border-violet-200 italic">
              {partialText}
            </div>
            <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-sm shrink-0">🧑</div>
          </div>
        )}

        <div ref={transcriptRef} />
      </div>

      {/* Bottom hint */}
      <div className="bg-white/80 border-t border-violet-100 px-4 py-2 text-center">
        <p className="text-xs text-slate-400">
          {turnState === 'listening' && 'Speak now — your mic is live'}
          {turnState === 'processing' && 'Claude is thinking…'}
          {turnState === 'speaking' && 'AI is responding — your mic is paused'}
          {turnState === 'idle' && 'Starting up…'}
        </p>
      </div>
    </main>
  );
}
