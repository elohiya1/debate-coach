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

export interface FallacyResult {
  fallacy: string | null;
  explanation: string | null;
}

export async function POST(req: Request) {
  const { statement, priorStatements } = (await req.json()) as {
    statement: string;
    priorStatements: string[];
  };

  const priorContext = priorStatements.length
    ? `Prior statements by this speaker:\n${priorStatements.map((s, i) => `${i + 1}. "${s}"`).join('\n')}\n\n`
    : '';

  const prompt =
    `${priorContext}Latest statement: "${statement}"\n\n` +
    `Check ONLY the latest statement for these logical fallacies or contradictions with prior statements:\n` +
    `- Strawman: misrepresenting the opponent's argument\n` +
    `- False dichotomy: presenting only two options when more exist\n` +
    `- Ad hominem: attacking the person rather than the argument\n` +
    `- Slippery slope: assuming one event inevitably leads to extreme outcomes\n` +
    `- Appeal to authority: citing authority without supporting evidence\n` +
    `- Contradiction: directly contradicts one of their own prior statements\n\n` +
    `Respond ONLY with valid JSON, no markdown, no explanation outside the JSON:\n` +
    `{"fallacy":"FallacyName or null","explanation":"one sentence or null"}`;

  const client  = makeClient();
  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  try {
    const res  = await client.send(command);
    const body = JSON.parse(new TextDecoder().decode(res.body)) as {
      content: { text: string }[];
    };
    const result = JSON.parse(body.content[0].text) as FallacyResult;
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ fallacy: null, explanation: null });
  }
}
