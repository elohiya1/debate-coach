import { NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0';

function makeClient() {
  return new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export interface ScoreResult {
  argumentStrength:  { score: number; feedback: string };
  logicalConsistency: { score: number; feedback: string };
  useOfEvidence:     { score: number; feedback: string };
  rebuttalQuality:   { score: number; feedback: string };
  overall:           { score: number; summary: string };
}

export async function POST(req: Request) {
  const { transcript, topic, userSide } = (await req.json()) as {
    transcript: string;
    topic: string;
    userSide: string;
  };

  const prompt =
    `You are an expert debate judge. Score the human debater's performance.\n\n` +
    `Debate topic: "${topic}"\n` +
    `Human argued: ${userSide}\n\n` +
    `Full transcript (User = the human being scored, AI = the opponent):\n${transcript}\n\n` +
    `Score the HUMAN ONLY on these 4 criteria from 1–10 with one-sentence feedback each.\n` +
    `Respond ONLY with valid JSON, no markdown:\n` +
    `{\n` +
    `  "argumentStrength":   {"score": 0–10, "feedback": "..."},\n` +
    `  "logicalConsistency": {"score": 0–10, "feedback": "..."},\n` +
    `  "useOfEvidence":      {"score": 0–10, "feedback": "..."},\n` +
    `  "rebuttalQuality":    {"score": 0–10, "feedback": "..."},\n` +
    `  "overall":            {"score": 0–10, "summary": "2–3 sentence overall assessment"}\n` +
    `}`;

  const client  = makeClient();
  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  try {
    const res  = await client.send(command);
    const body = JSON.parse(new TextDecoder().decode(res.body)) as {
      content: { text: string }[];
    };
    const result = JSON.parse(body.content[0].text) as ScoreResult;
    return NextResponse.json(result);
  } catch (err) {
    console.error('Scoring error:', err);
    return NextResponse.json({ error: 'Failed to generate scores.' }, { status: 500 });
  }
}
