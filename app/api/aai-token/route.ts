import { NextResponse } from 'next/server';

/**
 * Mints a short-lived AssemblyAI Streaming STT token.
 *
 * IMPORTANT: Streaming STT uses a plain API key in the Authorization header —
 * NO "Bearer" prefix. This is different from the Voice Agent API.
 */
export async function GET() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ASSEMBLYAI_API_KEY is not set.' }, { status: 500 });
  }

  const res = await fetch(
    'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',
    { headers: { Authorization: apiKey } }, // no Bearer prefix
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('AssemblyAI token error', res.status, body);
    return NextResponse.json({ error: 'Failed to mint streaming token.' }, { status: 502 });
  }

  const data = await res.json();
  return NextResponse.json({ token: data.token });
}
