import type { Methodology, MethodologyContext, EvaluationResult } from '../types';

export const StringMatch: Methodology = {
  name: 'string_match',
  async evaluate(ctx: MethodologyContext): Promise<EvaluationResult> {
    const { metric, inputs } = ctx;
    const target = String(inputs.target ?? inputs.answer ?? '');
    const expected = String(inputs.expected ?? inputs.reference ?? '');
    const normalized = (s: string) => (metric.params?.caseSensitive ? s : s.toLowerCase()).trim();
    const t = normalized(target);
    const e = normalized(expected);
    const success = t.includes(e);
    const score = success ? 1 : 0;
    return { metric: metric.name, success, score, details: { target, expected } };
  },
};
