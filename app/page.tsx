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

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** ArrayBuffer → base64 string (avoids spread-overflow on large buffers). */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 string → Int16Array */
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
    idle: 'bg-zinc-800 text-zinc-400',
    connecting: 'bg-amber-900/60 text-amber-300 animate-pulse',
    active: 'bg-emerald-900/60 text-emerald-300',
    stopped: 'bg-zinc-800 text-zinc-500',
    error: 'bg-red-900/60 text-red-300',
  };
  const labels: Record<Status, string> = {
    idle: 'Ready',
    connecting: 'Connecting…',
    active: '● Live',
    stopped: 'Session ended',
    error: 'Error',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400 tracking-tight">
      {'★'.repeat(Math.max(0, Math.min(5, rating)))}
      <span className="text-zinc-600">{'★'.repeat(5 - Math.max(0, Math.min(5, rating)))}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Session config sent as session.update
// ---------------------------------------------------------------------------

const SESSION_UPDATE = {
  type: 'session.update',
  session: {
    system_prompt:
      "You are a friendly but sharp mock interview coach running a spoken practice behavioral interview. " +
      "Greet the candidate and ask what role they're interviewing for. " +
      "Then ask one question at a time, listen to their answer, and ask one natural follow-up before moving on. " +
      "Keep your turns short and conversational — this is spoken aloud, not read. " +
      "Cover about 4–5 questions total. " +
      "After each candidate answer, call save_feedback with a 1–5 rating and a one-line note. " +
      "When you've covered enough ground, wrap up and give a brief spoken summary of strengths and one or two things to work on.",
    greeting: "Hey, I'm your interview coach today. What role are you practicing for?",
    input: {
      format: { encoding: 'audio/pcm' },
      turn_detection: {
        vad_threshold: 0.5,
        min_silence: 300,
        max_silence: 1200,
        interrupt_response: true,
      },
    },
    output: {
      voice: 'ivy',
      format: { encoding: 'audio/pcm' },
    },
    tools: [
      {
        // Flat schema — NOT OpenAI's nested { type:"function", function:{...} }
        type: 'function',
        name: 'save_feedback',
        description: "Record an assessment of the candidate's most recent answer.",
        parameters: {
          type: 'object',
          properties: {
            rating: { type: 'integer', description: '1–5 quality score' },
            note: { type: 'string', description: 'One-line coaching observation' },
          },
          required: ['rating', 'note'],
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Page() {
  const [status, setStatus] = useState<Status>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  // Stable refs — no re-render needed
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionReadyRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  /** Pending tool call waiting for reply.done before we respond. */
  const pendingToolRef = useRef<{ call_id: string } | null>(null);
  const msgIdRef = useRef(0);
  const fbIdRef = useRef(0);

  // Auto-scroll transcript
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

    const int16 = fromBase64(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const audioBuf = ctx.createBuffer(1, float32.length, 24000);
    audioBuf.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);

    // Queue gaplessly: start at max(now + tiny buffer, nextPlayTime)
    const startAt = Math.max(ctx.currentTime + 0.02, nextPlayTimeRef.current);
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

        case 'transcript.user':
          setMessages((prev) => [
            ...prev,
            { id: msgIdRef.current++, role: 'user', text: msg.transcript as string },
          ]);
          break;

        case 'transcript.agent':
          setMessages((prev) => [
            ...prev,
            { id: msgIdRef.current++, role: 'agent', text: msg.transcript as string },
          ]);
          break;

        case 'reply.audio':
          // IMPORTANT: agent audio arrives in the `data` field, NOT `audio`.
          playChunk(msg.data as string);
          break;

        case 'reply.done': {
          const interrupted = (msg.status as string) === 'interrupted';
          if (interrupted) {
            flushPlayback();
            pendingToolRef.current = null;
          } else if (pendingToolRef.current) {
            wsRef.current?.send(
              JSON.stringify({
                type: 'tool.result',
                call_id: pendingToolRef.current.call_id,
                result: 'Feedback recorded.',
              }),
            );
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
            // Store pending tool call — reply with result after reply.done fires.
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

  const start = useCallback(async () => {
    setErrorMsg('');
    setMessages([]);
    setFeedback([]);
    setStatus('connecting');
    sessionReadyRef.current = false;
    pendingToolRef.current = null;

    try {
      // 1. Mint a fresh single-use token from our server route.
      const tokenRes = await fetch('/api/token');
      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to fetch session token');
      }
      const { token } = (await tokenRes.json()) as { token: string };

      // 2. Create AudioContext at 24 kHz.
      //    Safari ignores sampleRate — the worklet handles resampling.
      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;
      await audioCtx.resume(); // required after a user gesture

      // 3. Load the PCM worklet.
      await audioCtx.audioWorklet.addModule('/worklet.js');

      // 4. Request mic with echo cancellation so the agent's voice isn't re-captured.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const micSource = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      micSource.connect(workletNode);
      // Do NOT connect workletNode to audioCtx.destination — that would feed mic back to speakers.

      // 5. Open WebSocket — token in query string, no Authorization header from browser.
      const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send session config immediately — do not wait for session.ready.
        ws.send(JSON.stringify(SESSION_UPDATE));
      };

      ws.onmessage = (ev) => {
        try {
          handleServerEvent(JSON.parse(ev.data as string));
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onclose = (ev) => {
        sessionReadyRef.current = false;
        // Only transition if we're not already in a terminal state from stop().
        setStatus((s) => (s === 'active' || s === 'connecting' ? 'stopped' : s));
        if (ev.code === 1008) {
          setErrorMsg('Unauthorized — check that ASSEMBLYAI_API_KEY is set correctly.');
        }
      };

      ws.onerror = () => {
        setErrorMsg('WebSocket error. Ensure the API key is valid and you have mic access.');
        setStatus('error');
      };

      // 6. Forward worklet PCM chunks to the WebSocket.
      //    Only send after session.ready sets sessionReadyRef.
      workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (!sessionReadyRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'input.audio', audio: toBase64(ev.data) }));
      };

      nextPlayTimeRef.current = 0;
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
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    flushPlayback();
    setStatus('stopped');
  }, [flushPlayback]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isIdle = status === 'idle' || status === 'stopped' || status === 'error';
  const showContent = messages.length > 0 || feedback.length > 0;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* ── Header ── */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none">🎙️</span>
          <div>
            <h1 className="font-bold text-base leading-tight">Interview Coach</h1>
            <p className="text-zinc-500 text-xs">Powered by AssemblyAI Voice Agent</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </header>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto px-4 py-8 gap-6">
        {/* Control area */}
        <div className="flex flex-col items-center gap-4">
          {isIdle ? (
            <button
              onClick={start}
              className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 active:scale-95 rounded-2xl font-semibold text-lg transition-all shadow-lg shadow-indigo-950/60 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {status === 'stopped' ? 'Start New Session' : 'Start Session'}
            </button>
          ) : status === 'connecting' ? (
            <button
              disabled
              className="px-8 py-4 bg-zinc-700 rounded-2xl font-semibold text-lg opacity-60 cursor-not-allowed"
            >
              Connecting…
            </button>
          ) : (
            <button
              onClick={stop}
              className="px-8 py-4 bg-rose-700 hover:bg-rose-600 active:scale-95 rounded-2xl font-semibold text-lg transition-all focus:outline-none focus:ring-2 focus:ring-rose-400"
            >
              End Session
            </button>
          )}

          {errorMsg && (
            <p className="text-red-400 text-sm text-center max-w-md bg-red-950/40 border border-red-900/50 rounded-xl px-4 py-2">
              {errorMsg}
            </p>
          )}

          {status === 'idle' && (
            <p className="text-zinc-500 text-sm text-center max-w-sm leading-relaxed">
              Click <strong className="text-zinc-300">Start Session</strong>, then allow microphone
              access. Your coach will guide you through a live behavioral interview.
            </p>
          )}

          {status === 'active' && (
            <p className="text-emerald-500 text-xs text-center animate-pulse">
              Microphone active — speak naturally
            </p>
          )}
        </div>

        {/* Conversation + Feedback */}
        {showContent && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* ── Transcript panel ── */}
            <section className="lg:col-span-2 bg-zinc-900 rounded-2xl border border-zinc-800 flex flex-col overflow-hidden max-h-[65vh]">
              <div className="px-4 py-2.5 border-b border-zinc-800">
                <span className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
                  Conversation
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 scroll-smooth">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex gap-2 items-end ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {m.role === 'agent' && (
                      <div className="w-6 h-6 rounded-full bg-indigo-700 flex items-center justify-center text-[10px] shrink-0">
                        🤖
                      </div>
                    )}
                    <div
                      className={`max-w-[78%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                        m.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
                      }`}
                    >
                      {m.text}
                    </div>
                    {m.role === 'user' && (
                      <div className="w-6 h-6 rounded-full bg-zinc-600 flex items-center justify-center text-[10px] shrink-0">
                        🧑
                      </div>
                    )}
                  </div>
                ))}
                <div ref={transcriptBottomRef} />
              </div>
            </section>

            {/* ── Feedback panel ── */}
            <section className="bg-zinc-900 rounded-2xl border border-zinc-800 flex flex-col overflow-hidden max-h-[65vh]">
              <div className="px-4 py-2.5 border-b border-zinc-800">
                <span className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
                  Coach Feedback
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
                {feedback.length === 0 ? (
                  <p className="text-zinc-600 text-xs text-center mt-6 leading-relaxed px-2">
                    Scores appear here after each answer
                  </p>
                ) : (
                  feedback.map((f, i) => (
                    <div
                      key={f.id}
                      className="bg-zinc-800 rounded-xl p-3 border border-zinc-700/60"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-zinc-400 font-medium">Answer {i + 1}</span>
                        <div className="flex items-center gap-1.5">
                          <Stars rating={f.rating} />
                          <span className="text-xs text-zinc-500">{f.rating}/5</span>
                        </div>
                      </div>
                      <p className="text-xs text-zinc-300 leading-snug">{f.note}</p>
                    </div>
                  ))
                )}
              </div>

              {/* Running average */}
              {feedback.length >= 2 && (
                <div className="border-t border-zinc-800 px-3 py-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Average</span>
                  <div className="flex items-center gap-1.5">
                    <Stars
                      rating={Math.round(
                        feedback.reduce((s, f) => s + f.rating, 0) / feedback.length,
                      )}
                    />
                    <span className="text-xs text-zinc-400">
                      {(feedback.reduce((s, f) => s + f.rating, 0) / feedback.length).toFixed(1)}
                    </span>
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
