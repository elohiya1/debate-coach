import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

// Model ID — verify this is enabled in your Bedrock region.
// Cross-region inference profile prefix ('us.') is required in many accounts.
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

export async function POST(req: Request) {
  const { messages, system } = (await req.json()) as {
    messages: { role: 'user' | 'assistant'; content: string }[];
    system: string;
  };

  const client  = makeClient();
  const command = new InvokeModelWithResponseStreamCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 300,
      system,
      messages,
    }),
  });

  const bedrockRes = await client.send(command);

  // Stream plain text back to the browser.
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of bedrockRes.body!) {
          if (event.chunk?.bytes) {
            const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes)) as {
              type: string;
              delta?: { type: string; text?: string };
            };
            if (
              parsed.type === 'content_block_delta' &&
              parsed.delta?.type === 'text_delta' &&
              parsed.delta.text
            ) {
              controller.enqueue(new TextEncoder().encode(parsed.delta.text));
            }
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
