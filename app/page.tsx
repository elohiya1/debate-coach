'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Status = 'idle' | 'connecting' | 'active' | 'stopped' | 'error';

interface Message {
  id: number;
  role: 'user' | 'agent';
  text: string;
}

interface FeedbackItem {
  id: number;
  rating: number;
  note: string;
}

interface Role {
  id: string;
  label: string;
  emoji: string;
  description: string;
  prompt: string;
  greeting: string;
}

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------

const ROLES: Role[] = [
  {
    id: 'swe',
    label: 'Software Engineer',
    emoji: '💻',
    description: 'Big Tech, FAANG, startups',
    prompt:
      'software engineering roles at top tech companies like Google, Meta, Amazon, or high-growth startups. Focus on technical leadership, system design decisions, and collaboration.',
    greeting: "Hey! I'm your interview coach. Let's prep for software engineering. Which company or type of role are you targeting?",
  },
  {
    id: 'consultant',
    label: 'Consultant',
    emoji: '💼',
    description: 'McKinsey, BCG, Bain & top firms',
    prompt:
      'management consulting roles at top firms like McKinsey, BCG, or Bain. Focus on structured thinking, leadership, client impact, and driving change under ambiguity.',
    greeting: "Hi! Ready to prep for consulting? I'll walk you through behavioral questions. Which firm or practice area are you targeting?",
  },
  {
    id: 'banker',
    label: 'Investment Banker',
    emoji: '🏦',
    description: 'Bulge bracket & boutique banks',
    prompt:
      'investment banking roles at bulge bracket or boutique banks. Focus on work ethic, attention to detail, deal experience, client relationships, and navigating high-pressure environments.',
    greeting: "Hey, let's get you ready for banking interviews. Behavioral questions are critical here. What bank or group are you targeting?",
  },
  {
    id: 'pm',
    label: 'Product Manager',
    emoji: '📱',
    description: 'Tech companies & startups',
    prompt:
      'product management roles at tech companies. Focus on customer empathy, data-driven decisions, cross-functional leadership, prioritization, and shipping impactful products.',
    greeting: "Hi! Let's work on your PM interview prep. I'll focus on behavioral and leadership questions. What kind of PM role are you going for?",
  },
  {
    id: 'marketing',
    label: 'Marketing',
    emoji: '🎯',
    description: 'Brand, growth & strategy roles',
    prompt:
      'marketing roles including brand management, growth marketing, and marketing strategy. Focus on consumer insight, campaign results, cross-functional work, and data-driven decisions.',
    greeting: "Hey! Let's prep your marketing interview. I'll ask about your past experience and how you think about brand and growth. What role are you targeting?",
  },
];

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    idle:       'bg-violet-100 text-violet-600',
    connecting: 'bg-amber-100 text-amber-600 animate-pulse',
    active:     'bg-emerald-100 text-emerald-700',
    stopped:    'bg-slate-100 text-slate-500',
    error:      'bg-red-100 text-red-600',
  };
  const labels: Record<Status, string> = {
    idle:       'Ready',
    connecting: 'Connecting…',
    active:     '● Live',
    stopped:    'Session ended',
    error:      'Error',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  const n = Math.max(0, Math.min(5, rating));
  return (
    <span>
      <span className="text-amber-400">{'★'.repeat(n)}</span>
      <span className="text-slate-300">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Page() {
  const [status, setStatus]   = useState<Status>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedRole, setSelectedRole] = useState<Role>(ROLES[0]);

  const wsRef               = useRef<WebSocket | null>(null);
  const audioCtxRef         = useRef<AudioContext | null>(null);
  const streamRef           = useRef<MediaStream | null>(null);
  const sessionReadyRef     = useRef(false);
  const nextPlayTimeRef     = useRef(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const pendingToolRef      = useRef<{ call_id: string } | null>(null);
  const msgIdRef            = useRef(0);
  const fbIdRef             = useRef(0);

  const transcriptBottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  const flushPlayback = useCallback(() => {
    scheduledSourcesRef.current.forEach((src) => {
      try { src.stop(0); } catch { /* already ended */ }
    });
    scheduledSourcesRef.current = [];
    if (audioCtxRef.current) nextPlayTimeRef.current = audioCtxRef.current.currentTime;
  }, []);

  const playChunk = useCallback((data: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    // Resume in case the browser auto-suspended the context.
    if (ctx.state === 'suspended') ctx.resume();

    const int16   = fromBase64(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const audioBuf = ctx.createBuffer(1, float32.length, 24000);
    audioBuf.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);

    // Use a 100 ms ahead-of-now buffer to absorb network jitter.
    // On the very first chunk nextPlayTimeRef is 0, so we start 100 ms from now.
    const startAt = Math.max(ctx.currentTime + 0.1, nextPlayTimeRef.current);
    src.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuf.duration;

    scheduledSourcesRef.current.push(src);
    src.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== src);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  const handleServerEvent = useCallback(
    (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'session.ready':
          sessionReadyRef.current = true;
          setStatus('active');
          break;

        case 'transcript.user': {
          // The docs show `transcript` field; browser-integration page shows `text`.
          // Handle both to be safe.
          const text = (msg.transcript ?? msg.text) as string | undefined;
          if (text) {
            setMessages((prev) => [...prev, { id: msgIdRef.current++, role: 'user', text }]);
          }
          break;
        }

        case 'transcript.agent': {
          const text = (msg.transcript ?? msg.text) as string | undefined;
          if (text) {
            setMessages((prev) => [...prev, { id: msgIdRef.current++, role: 'agent', text }]);
          }
          break;
        }

        case 'reply.audio':
          // Agent audio arrives in `data`, NOT `audio` (that's the input field name).
          playChunk(msg.data as string);
          break;

        case 'reply.done': {
          const interrupted = (msg.status as string) === 'interrupted';
          if (interrupted) {
            flushPlayback();
            pendingToolRef.current = null;
          } else if (pendingToolRef.current) {
            wsRef.current?.send(JSON.stringify({
              type: 'tool.result',
              call_id: pendingToolRef.current.call_id,
              result: 'Feedback recorded.',
            }));
            pendingToolRef.current = null;
          }
          break;
        }

        case 'tool.call': {
          if (msg.name === 'save_feedback') {
            const args =
              typeof msg.arguments === 'string'
                ? (JSON.parse(msg.arguments) as { rating: number; note: string })
                : (msg.arguments as { rating: number; note: string });
            setFeedback((prev) => [
              ...prev,
              { id: fbIdRef.current++, rating: args.rating, note: args.note },
            ]);
            pendingToolRef.current = { call_id: msg.call_id as string };
          }
          break;
        }

        case 'session.error':
          setErrorMsg(`Session error: ${(msg.code as string) ?? 'unknown'}`);
          setStatus('error');
          break;

        default:
          break;
      }
    },
    [playChunk, flushPlayback],
  );

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  const start = useCallback(async (role: Role) => {
    setErrorMsg('');
    setMessages([]);
    setFeedback([]);
    setStatus('connecting');
    sessionReadyRef.current = false;
    pendingToolRef.current  = null;
    nextPlayTimeRef.current = 0;

    try {
      // Set up audio FIRST (slow), then mint token right before opening the WebSocket
      // so the token doesn't expire during AudioWorklet/mic setup.
      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('/worklet.js');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      // Mint token last — tokens are single-use and expire quickly.
      const tokenRes = await fetch('/api/token');
      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to fetch session token');
      }
      const { token } = (await tokenRes.json()) as { token: string };

      const micSource  = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      micSource.connect(workletNode);
      // Do NOT connect to destination — would cause mic feedback through speakers.

      const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            system_prompt:
              `You are a friendly but sharp mock interview coach running a spoken practice behavioral interview for ${role.prompt} ` +
              'Ask one behavioral question at a time, listen to the answer, then ask one natural follow-up before moving on. ' +
              'Keep your turns short and conversational — this is spoken aloud, not read. ' +
              'Cover 4–5 questions total. After each candidate answer, call save_feedback with a 1–5 rating and a one-line coaching note. ' +
              'When done, give a brief spoken summary of two strengths and one or two things to work on.',
            greeting: role.greeting,
            input: {
              format: { encoding: 'audio/pcm' },
              turn_detection: {
                vad_threshold: 0.5,
                min_silence: 400,
                max_silence: 1500,
                interrupt_response: true,
              },
            },
            output: {
              voice: 'ivy',
              format: { encoding: 'audio/pcm' },
            },
            tools: [{
              type: 'function',
              name: 'save_feedback',
              description: "Record an assessment of the candidate's most recent answer.",
              parameters: {
                type: 'object',
                properties: {
                  rating: { type: 'integer', description: '1–5 quality score' },
                  note:   { type: 'string',  description: 'One-line coaching observation' },
                },
                required: ['rating', 'note'],
              },
            }],
          },
        }));
      };

      ws.onmessage = (ev) => {
        try { handleServerEvent(JSON.parse(ev.data as string)); } catch { /* ignore */ }
      };

      ws.onclose = (ev) => {
        sessionReadyRef.current = false;
        setStatus((s) => (s === 'active' || s === 'connecting' ? 'stopped' : s));
        if (ev.code === 1008 || ev.code === 1006) {
          setErrorMsg(`Auth failed (code ${ev.code}) — the session token was rejected. Check that ASSEMBLYAI_API_KEY is valid and has Voice Agent access.`);
        }
      };

      ws.onerror = () => {
        setErrorMsg('WebSocket error. Check your API key and mic permissions.');
        setStatus('error');
      };

      workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (!sessionReadyRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'input.audio', audio: toBase64(ev.data) }));
      };
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [handleServerEvent]);

  const stop = useCallback(() => {
    sessionReadyRef.current = false;
    wsRef.current?.close(1000, 'User ended session');
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current  = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    flushPlayback();
    setStatus('stopped');
  }, [flushPlayback]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isIdle      = status === 'idle' || status === 'stopped' || status === 'error';
  const showContent = messages.length > 0 || feedback.length > 0;
  const avgRating   = feedback.length
    ? feedback.reduce((s, f) => s + f.rating, 0) / feedback.length
    : 0;

  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-slate-100 text-slate-800 flex flex-col font-sans">

      {/* ── Header ── */}
      <header className="bg-white/80 backdrop-blur border-b border-violet-100 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-white text-lg shadow-sm">
            🎙️
          </div>
          <div>
            <h1 className="font-bold text-slate-900 leading-tight">Interview Coach</h1>
            <p className="text-violet-400 text-xs">Powered by AssemblyAI</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </header>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto px-4 py-8 gap-6">

        {/* ── Role selector (shown when not in active session) ── */}
        {isIdle && (
          <div className="flex flex-col items-center gap-5">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-slate-900">Pick your interview track</h2>
              <p className="text-slate-500 text-sm mt-1">
                Your coach will tailor every question to the role you choose.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 w-full">
              {ROLES.map((role) => (
                <button
                  key={role.id}
                  onClick={() => setSelectedRole(role)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all text-center ${
                    selectedRole.id === role.id
                      ? 'border-violet-500 bg-violet-50 shadow-md shadow-violet-100'
                      : 'border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/50'
                  }`}
                >
                  <span className="text-2xl">{role.emoji}</span>
                  <span className="text-xs font-semibold text-slate-700 leading-tight">{role.label}</span>
                  <span className="text-[10px] text-slate-400 leading-tight">{role.description}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => start(selectedRole)}
              className="mt-1 px-10 py-4 bg-violet-600 hover:bg-violet-500 active:scale-95 text-white rounded-2xl font-semibold text-lg transition-all shadow-lg shadow-violet-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              Start {selectedRole.emoji} Interview
            </button>

            {errorMsg && (
              <p className="text-red-500 text-sm text-center max-w-md bg-red-50 border border-red-200 rounded-xl px-4 py-2">
                {errorMsg}
              </p>
            )}
          </div>
        )}

        {/* ── Connecting spinner ── */}
        {status === 'connecting' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="w-12 h-12 rounded-full border-4 border-violet-200 border-t-violet-600 animate-spin" />
            <p className="text-slate-500 text-sm">Setting up your session…</p>
          </div>
        )}

        {/* ── Active controls ── */}
        {status === 'active' && (
          <div className="flex items-center justify-between bg-white rounded-2xl border border-violet-100 px-5 py-3 shadow-sm">
            <div className="flex items-center gap-2.5">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-sm font-medium text-slate-700">
                {selectedRole.emoji} {selectedRole.label} interview — microphone live
              </span>
            </div>
            <button
              onClick={stop}
              className="px-4 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl text-sm font-medium transition-all"
            >
              End Session
            </button>
          </div>
        )}

        {/* ── Stopped banner ── */}
        {status === 'stopped' && !showContent && (
          <div className="flex flex-col items-center gap-3 py-4">
            <p className="text-slate-500 text-sm">Session ended.</p>
          </div>
        )}

        {/* ── Conversation + Feedback ── */}
        {showContent && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Transcript */}
            <section className="lg:col-span-2 bg-white rounded-2xl border border-violet-100 shadow-sm flex flex-col overflow-hidden max-h-[62vh]">
              <div className="px-4 py-2.5 border-b border-violet-50 flex items-center gap-2">
                <span className="text-xs font-semibold text-violet-500 uppercase tracking-widest">Conversation</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex gap-2 items-end ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {m.role === 'agent' && (
                      <div className="w-7 h-7 rounded-full bg-violet-100 border border-violet-200 flex items-center justify-center text-sm shrink-0">
                        🤖
                      </div>
                    )}
                    <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-violet-600 text-white rounded-br-sm shadow-sm'
                        : 'bg-violet-50 text-slate-800 border border-violet-100 rounded-bl-sm'
                    }`}>
                      {m.text}
                    </div>
                    {m.role === 'user' && (
                      <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-sm shrink-0">
                        🧑
                      </div>
                    )}
                  </div>
                ))}
                <div ref={transcriptBottomRef} />
              </div>
            </section>

            {/* Feedback */}
            <section className="bg-white rounded-2xl border border-violet-100 shadow-sm flex flex-col overflow-hidden max-h-[62vh]">
              <div className="px-4 py-2.5 border-b border-violet-50">
                <span className="text-xs font-semibold text-violet-500 uppercase tracking-widest">Coach Feedback</span>
              </div>
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
                {feedback.length === 0 ? (
                  <p className="text-slate-400 text-xs text-center mt-8 leading-relaxed px-2">
                    Scores appear here after each answer
                  </p>
                ) : (
                  feedback.map((f, i) => (
                    <div key={f.id} className="bg-violet-50 rounded-xl p-3 border border-violet-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-violet-600">Answer {i + 1}</span>
                        <div className="flex items-center gap-1">
                          <Stars rating={f.rating} />
                          <span className="text-xs text-slate-400 ml-1">{f.rating}/5</span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-600 leading-snug">{f.note}</p>
                    </div>
                  ))
                )}
              </div>

              {feedback.length >= 2 && (
                <div className="border-t border-violet-50 px-4 py-3 flex items-center justify-between bg-violet-50/50">
                  <span className="text-xs font-semibold text-slate-500">Average</span>
                  <div className="flex items-center gap-1.5">
                    <Stars rating={Math.round(avgRating)} />
                    <span className="text-xs font-bold text-violet-700 ml-1">{avgRating.toFixed(1)}</span>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
