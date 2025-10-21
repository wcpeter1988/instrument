import { InstrumentMethod, InstrumentVar, logVar, InstrumentType } from '@workspace/instrument';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* mockLLMGenerate(prompt: string, opts?: { delayMs?: number }) {
  // Async generator to simulate streaming tokens
  const delay = opts?.delayMs ?? 10;
  const tokens = ['Let\'s ', 'answer ', 'based ', 'on ', 'context: ', prompt.slice(0, 20), '...'];
  for (const t of tokens) {
    await sleep(delay);
    yield t;
  }
}

export async function streamLLM(
  prompt: string,
  onChunk: (chunk: string) => void,
  opts?: { delayMs?: number }
): Promise<string> {
  let acc = '';
  for await (const chunk of mockLLMGenerate(prompt, opts)) {
    onChunk(chunk);
    acc += chunk;
  }
  return acc;
}

// Minimal interfaces for the mock client and store used by the workflow
export interface IOpenAiChatClient {
  complete(prompt: string, options?: { stream?: boolean }): Promise<string>;
}

export interface IWorkflowStore {
  save?(key: string, value: unknown): Promise<void> | void;
}

// Decorator-based variant (kept for context service only)
export class DecoratedContextService {
  @InstrumentMethod({ label: 'fetchContext', params: { question: InstrumentType.TraceAndReplay }, return: InstrumentType.Trace })
  async fetchContext(question: string): Promise<string[]> {
    await sleep(20);
    return [
      `Q:${question}`,
      'doc: how to mock workflows',
      'tip: use instrumentation to trace steps',
    ];
  }

  @InstrumentMethod({ label: 'getMeetingInsight', params: { transcript: InstrumentType.TraceAndReplay }, return: InstrumentType.Trace })
  public async getMeetingInsight(
    client: IOpenAiChatClient,
    transcript?: string,
    workflowStore?: IWorkflowStore,
    promptVersion?: string
  ): Promise<string> {
    const mockTranscript =
      transcript ??
      [
        'Speaker A: Welcome everyone, today we review Q3 numbers and roadmap.',
        'Speaker B: Revenue grew 12%, churn decreased 1.2%.',
        'Speaker C: Top risks are hiring and infra costs.',
        'Action Items: finalize budget, schedule hiring plan, optimize cloud spend.',
      ].join('\n');

    const version = promptVersion ?? 'v1';
    let prompt = `[meeting-summary ${version} __]`;
    logVar(prompt, 'prompt');
    const fullPrompt = `${prompt}\n${mockTranscript}`;

    const summary = await client.complete(fullPrompt, { stream: false });
    await workflowStore?.save?.('meeting-summary', { version, length: mockTranscript.length });
    return summary.trim();
  }
}

export async function runMockServiceDecorated(question: string): Promise<string> {
  // Use the decorated context service for a question-specific context
  const contextSvc = new DecoratedContextService();
  const context = await contextSvc.fetchContext(question);

  // Prepare a mock transcript and client, call the refactored function, and stream chunks for E2E shape
  const mockTranscript = [
    'Speaker A: Welcome everyone, today we review Q3 numbers and roadmap.',
    'Speaker B: Revenue grew 12%, churn decreased 1.2%.',
    'Speaker C: Top risks are hiring and infra costs.',
    'Action Items: finalize budget, schedule hiring plan, optimize cloud spend.',
    context
  ].join('\n');

  const mockClient: IOpenAiChatClient = {
    async complete(prompt: string) {
      await sleep(10);
      // Return a mock meeting summary (concise) based on prompt length
      return `Summary: Reviewed Q4, revenue up, churn down. Risks: hiring & infra. Actions: budget, hiring plan, optimize cloud.`;
    },
  };

  const final = await contextSvc.getMeetingInsight(mockClient, mockTranscript, undefined, 'v1');
  const chunks = final.match(/.{1,12}/g) || [final];
  const full = chunks.join('');

  return full;
}
