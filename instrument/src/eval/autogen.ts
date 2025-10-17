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
  // We'll inspect units to see if there are annotation entries and derive extra metrics.
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
  // Derive annotation-based metrics: look for a unit whose tagId === 'annotations'.
  const annotationUnits = units.filter(u => u.tagId === 'annotations');
  if (annotationUnits.length) {
    // Extract keys (e.g., summary) from any plausible location.
    const collectedKeys = new Set<string>();
    const sampleValues: Record<string, any> = {};
    for (const u of annotationUnits) {
      // Heuristic: annotations might live directly under args, return, vars, or nested inside an 'annotations' arg.
      const candidates: Record<string, any>[] = [];
      if (u.payload.args && typeof u.payload.args === 'object') candidates.push(u.payload.args);
      if (u.payload.return && typeof u.payload.return === 'object') candidates.push(u.payload.return);
      if ((u as any).payload.annotations && typeof (u as any).payload.annotations === 'object') candidates.push((u as any).payload.annotations);
      if (u.payload.vars && typeof u.payload.vars === 'object') {
        const varsObj: Record<string, any> = {};
        for (const [k, v] of Object.entries(u.payload.vars)) {
          if (v && typeof v === 'object' && 'value' in v) varsObj[k] = (v as any).value;
        }
        candidates.push(varsObj);
      }
      for (const obj of candidates) {
        for (const [k, v] of Object.entries(obj)) {
          collectedKeys.add(k);
          if (!(k in sampleValues) && (typeof v === 'string' || typeof v === 'number')) sampleValues[k] = v;
        }
      }
    }
    // Focus on 'summary' if present; else take first key.
    const primaryKey = collectedKeys.has('summary') ? 'summary' : (Array.from(collectedKeys)[0]);
    if (primaryKey) {
      // Build a query path starting with annotations.<key>
      // We expose a MetricConfig that can be used by methodologies to inspect this field.
      const annotationMetric: MetricConfig = {
        name: `annotation_${primaryKey}`,
        description: `Auto-generated metric derived from annotation key '${primaryKey}'.`,
        longDescription: `This metric leverages user-provided annotations (tagId=annotations). It surfaces the '${primaryKey}' field for downstream evaluation.` + (prompt ? `\n\nPrompt context applied: ${prompt}` : ''),
        methodology: 'string_match',
        query: { [primaryKey]: `annotations.${primaryKey}` },
        params: {
          sampleValue: sampleValues[primaryKey] ?? null,
          generatedFromAnnotations: true
        }
      };
      metrics.push(annotationMetric);
    }
  }

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
