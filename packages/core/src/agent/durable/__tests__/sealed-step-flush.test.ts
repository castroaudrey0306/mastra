/**
 * A step's flush is new output even when it reuses the id of a sealed message
 * and repeats that message's opening text. Both loops must keep it (#22802).
 */

import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { EventEmitterPubSub } from '../../../events/event-emitter';
import type { Processor } from '../../../processors';
import { createTool } from '../../../tools';
import { Agent } from '../../agent';
import type { MastraDBMessage } from '../../message-list';
import { createDurableAgent } from '../create-durable-agent';

function textChunks(id: string) {
  return [
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta: 'hello' },
    { type: 'text-end' as const, id },
  ];
}

function createModel() {
  let callCount = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      callCount++;
      const finish = callCount === 1 ? 'tool-calls' : 'stop';
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `id-${callCount}`, modelId: 'mock-model-id', timestamp: new Date(0) },
          ...textChunks(`text-${callCount}`),
          ...(callCount === 1
            ? [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'echoTool', input: '{}' }]
            : []),
          { type: 'finish', finishReason: finish, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

// Seals the first step's response the way observational memory marks a buffered message,
// then keeps the next step on that id. The regular loop reuses it anyway; the durable loop
// would otherwise rotate to a fresh one.
function createSealer() {
  let finalMessages: MastraDBMessage[] = [];
  const processor: Processor = {
    id: 'seal-first-step',
    processInputStep: async ({ stepNumber, messageList }) => {
      if (stepNumber !== 1) return { messageList };
      const [message] = messageList.get.response.db().filter(m => m.role === 'assistant');
      if (!message) throw new Error('expected the first step response');
      message.content.metadata = { ...message.content.metadata, mastra: { sealed: true } };
      const lastPart = message.content.parts.at(-1) as { metadata?: Record<string, unknown> };
      lastPart.metadata = { mastra: { sealedAt: Date.now() } };
      return { messageList, messageId: message.id };
    },
    processOutputResult: async ({ messageList, messages }) => {
      finalMessages = structuredClone(messageList.get.all.db());
      return messages;
    },
  };
  return { processor, messages: () => finalMessages };
}

function createAgent(processor: Processor) {
  return new Agent({
    id: 'sealed-flush-agent',
    name: 'Sealed Flush Agent',
    instructions: 'noop',
    model: createModel() as LanguageModelV2,
    tools: {
      echoTool: createTool({
        id: 'echoTool',
        description: 'echo',
        inputSchema: z.object({}),
        execute: async () => 'done',
      }),
    },
    inputProcessors: [processor],
    outputProcessors: [processor],
  });
}

async function drain(stream: ReadableStream<unknown>) {
  for await (const _ of stream) {
    // consume
  }
}

function helloTexts(messages: MastraDBMessage[]) {
  return messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => m.content.parts)
    .filter(p => p.type === 'text' && p.text === 'hello');
}

describe('step flush into a sealed message (#22802)', () => {
  let pubsub: EventEmitterPubSub | undefined;

  afterEach(async () => {
    await pubsub?.close();
    pubsub = undefined;
  });

  it('keeps the second step text in the regular loop', async () => {
    const sealer = createSealer();
    const result = await createAgent(sealer.processor).stream('go', { maxSteps: 2 });
    await drain(result.fullStream as unknown as ReadableStream<unknown>);

    expect(helloTexts(sealer.messages())).toHaveLength(2);
  });

  it('keeps the second step text in the durable loop', async () => {
    pubsub = new EventEmitterPubSub();
    const sealer = createSealer();
    const durableAgent = createDurableAgent({ agent: createAgent(sealer.processor), pubsub });

    const { output, cleanup } = await durableAgent.stream('go', { maxSteps: 2 });
    await drain(output.fullStream as unknown as ReadableStream<unknown>);
    await cleanup();

    expect(helloTexts(sealer.messages())).toHaveLength(2);
  });
});
