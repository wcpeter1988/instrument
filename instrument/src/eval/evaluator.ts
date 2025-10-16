import type { MetricConfig, EvaluationResult, LLM, MethodologyType } from './types';
import { projectInputs } from './query';
import type { LogUnit } from '@workspace/common';
import { DAG } from './methodologies/dag';
import { QAG } from './methodologies/qag';
import { StringMatch } from './methodologies/string_match';
import fs from 'fs';
import path from 'path';

const REGISTRY = {
  DAG,
  QAG,
  string_match: StringMatch,
} as const satisfies Record<MethodologyType, any>;

export class MockLLM implements LLM {
  async generate(prompt: string): Promise<string> {
    // trivial mock returns prompt length as string
    return `len:${prompt.length}`;
  }
}

export async function evaluateMetric(metric: MetricConfig, unit: LogUnit, llm: LLM = new MockLLM()): Promise<EvaluationResult> {
  const m = REGISTRY[metric.methodology as MethodologyType];
  if (!m) return { metric: metric.name, success: false, error: `Unknown methodology: ${metric.methodology}` };
  const inputs = projectInputs(unit, metric.query || {});
  try {
    return await m.evaluate({ metric, inputs, llm });
  } catch (err: any) {
    return { metric: metric.name, success: false, error: err?.message || String(err) };
  }
}

// Overload signatures
export async function evaluateAll(metrics: MetricConfig[], unit: LogUnit, llm?: LLM): Promise<EvaluationResult[]>;
export async function evaluateAll(configPath: string, units: LogUnit[], llm?: LLM): Promise<{ unit: LogUnit; results: EvaluationResult[] }[]>;

/**
 * evaluateAll(legacy): (metrics[], unit) -> EvaluationResult[]
 * evaluateAll(new): (metricsConfigPath, units[]) -> { unit, results[] }[]
 * The new interface lets you call in one line: const evals = await Eval.evaluateAll('eval.metrics.json', units)
 */
export async function evaluateAll(a: any, b: any, c: any = new MockLLM()): Promise<any> {
  const llm: LLM = c || new MockLLM();
  // New signature: (configPath: string, units: LogUnit[])
  if (typeof a === 'string' && Array.isArray(b)) {
    const configPath = path.isAbsolute(a) ? a : path.join(process.cwd(), a);
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read metrics config at ${configPath}: ${err?.message || err}`);
    }
    let metrics: MetricConfig[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Metrics JSON must be an array');
      metrics = parsed as MetricConfig[];
    } catch (err: any) {
      throw new Error(`Failed to parse metrics JSON (${configPath}): ${err?.message || err}`);
    }
    const results: { unit: LogUnit; results: EvaluationResult[] }[] = [];
    for (const unit of b as LogUnit[]) {
      const perUnit: EvaluationResult[] = [];
      for (const metric of metrics) {
        perUnit.push(await evaluateMetric(metric, unit, llm));
      }
      results.push({ unit, results: perUnit });
    }
    return results;
  }
  // Legacy signature: (metrics[], unit)
  if (Array.isArray(a) && b && !Array.isArray(b)) {
    const metrics: MetricConfig[] = a;
    const unit: LogUnit = b;
    const out: EvaluationResult[] = [];
    for (const metric of metrics) {
      out.push(await evaluateMetric(metric, unit, llm));
    }
    return out;
  }
  throw new Error('Invalid evaluateAll arguments');
}

// Explicit helper to avoid overload resolution issues in TS consumer code
export async function evaluateAllFromConfig(configPath: string, units: LogUnit[], llm: LLM = new MockLLM()) {
  return evaluateAll(configPath, units, llm) as Promise<{ unit: LogUnit; results: EvaluationResult[] }[]>;
}
