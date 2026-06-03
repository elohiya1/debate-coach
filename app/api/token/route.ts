import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ASSEMBLYAI_API_KEY is not configured on the server.' },
      { status: 500 },
    );
  }

  const res = await fetch(
    'https://agents.assemblyai.com/v1/token?expires_in_seconds=300&max_session_duration_seconds=1800',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('AssemblyAI token error', res.status, body);
    return NextResponse.json(
      { error: 'Failed to mint session token from AssemblyAI.' },
      { status: 502 },
    );
  }

  const data = await res.json();
  return NextResponse.json({ token: data.token });
}
