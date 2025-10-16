import type { Methodology, MethodologyContext, EvaluationResult } from '../types';

// Mock LLM grading: if answer contains all keywords from rubric, score 1 else 0.5/0
function heuristicScore(answer: string, rubric: string): number {
  const kws = rubric.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!kws.length) return answer ? 1 : 0;
  const a = answer.toLowerCase();
  const hits = kws.filter((k) => a.includes(k.toLowerCase())).length;
  return hits === kws.length ? 1 : hits > 0 ? 0.5 : 0;
}

export const QAG: Methodology = {
  name: 'QAG',
  async evaluate(ctx: MethodologyContext): Promise<EvaluationResult> {
    const { metric, inputs, llm } = ctx;
    const question = String(inputs.question ?? inputs.q ?? '');
    const answer = String(inputs.answer ?? inputs.a ?? '');
    const reference = String(inputs.reference ?? inputs.expected ?? '');
    const prompt = (metric.promptTemplate || 'Grade the answer to the question according to rubric. Question: {{question}}\nAnswer: {{answer}}\nRubric: {{reference}}\nReturn only a score 0..1.')
      .replace(/{{\s*question\s*}}/g, question)
      .replace(/{{\s*answer\s*}}/g, answer)
      .replace(/{{\s*reference\s*}}/g, reference);
    // Mock LLM: compute heuristic, then stringify
    const score = heuristicScore(answer, reference);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _llmResp = await llm.generate(prompt); // not used in mock, but keeps interface
    return { metric: metric.name, success: score >= (metric.params?.threshold ?? 0.5), score, details: { question, answer, reference } };
  },
};
