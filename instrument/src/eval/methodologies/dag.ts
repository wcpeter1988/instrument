import type { Methodology, MethodologyContext, EvaluationResult } from '../types';

function normalizeSteps(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string') return v.split(/\n|->|,/).map((s) => s.trim()).filter(Boolean);
  if (v && typeof v === 'object') return Object.values(v).map((x) => String(x)).filter(Boolean);
  return [];
}

function dagCoverage(reference: string[], actual: string[]): number {
  if (!reference.length) return actual.length ? 1 : 0;
  const a = actual.map((s) => s.toLowerCase());
  const hits = reference.filter((r) => a.includes(r.toLowerCase())).length;
  return hits / reference.length;
}

export const DAG: Methodology = {
  name: 'DAG',
  async evaluate(ctx: MethodologyContext): Promise<EvaluationResult> {
    const { metric, inputs, llm } = ctx;
    const expectedSteps = normalizeSteps(inputs.reference ?? inputs.expected ?? []);
    const actualSteps = normalizeSteps(inputs.steps ?? inputs.plan ?? inputs.answer ?? []);
    const prompt = (metric.promptTemplate || 'Evaluate plan steps against expected graph. Expected: {{reference}}\nActual: {{steps}}\nReturn coverage 0..1')
      .replace(/{{\s*reference\s*}}/g, expectedSteps.join(' | '))
      .replace(/{{\s*steps\s*}}/g, actualSteps.join(' | '));
    const _raw = await llm.generate(prompt); // not used in mock
    const score = dagCoverage(expectedSteps, actualSteps);
    return {
      metric: metric.name,
      success: score >= (metric.params?.threshold ?? 0.5),
      score,
      details: { expectedSteps, actualSteps },
    };
  },
};
