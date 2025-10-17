import fs from 'fs';
import path from 'path';
import type { MetricConfig } from './types';
import type { LogUnit } from '@workspace/common';

/**
 * Auto-generate a metrics configuration given a set of LogUnits.
 * Current mock implementation simply loads the example metrics from testbed/src/eval.metrics.json.
 * Future extension points:
 *  - Analyze units to infer targets / expected fields
 *  - Dynamically select methodologies based on content patterns
 *  - Allow filtering / parameter overrides
 */
export async function autoGenerateMetrics(units: LogUnit[], prompt?: string): Promise<MetricConfig[]> {
  // Silence unused param for now; logic can use units later to infer config.
  void units;
  // Use testbed metrics as mock source; adjust path relative to workspace root when built.
  // At runtime in dist, __dirname points to instrument/dist/eval, so go up two and into testbed/src.
  const metricsPath = path.resolve(__dirname, '..', '..', '..', 'testbed', 'src', 'eval.metrics.json');
  let raw: string;
  try {
    raw = fs.readFileSync(metricsPath, 'utf8');
  } catch (err: any) {
    throw new Error(`autoGenerateMetrics: failed to read mock metrics at ${metricsPath}: ${err?.message || err}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`autoGenerateMetrics: invalid JSON in ${metricsPath}: ${err?.message || err}`);
  }
  if (!Array.isArray(parsed)) throw new Error('autoGenerateMetrics: metrics JSON must be an array');
  const metrics = parsed as MetricConfig[];
  if (prompt) {
    // Non-destructive enhancement: annotate each metric's longDescription with prompt context.
    return metrics.map(m => ({
      ...m,
      longDescription: `${m.longDescription || ''}\n\n[autoGen context prompt]: ${prompt}`.trim()
    }));
  }
  return metrics;
}

// Convenience wrapper that returns both units and generated metrics (could evolve later)
export async function autoGenerate(units: LogUnit[], prompt?: string) {
  const metrics = await autoGenerateMetrics(units, prompt);
  return { metrics, count: metrics.length, promptIncluded: !!prompt };
}
