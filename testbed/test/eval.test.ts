import fs from 'fs';
import path from 'path';
import http from 'http';
import { Eval, EvalTypes } from '@workspace/instrument';

function get(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Map datalake GET flat item to LogUnit shape used by evaluator
function toLogUnit(item: any): any {
  // Data lake returns items as whatever was POSTed under payload; wrap as LogUnit compatible
  return {
    tagId: item?.payload?.tagId || item?.tagId || 'unknown',
    timestamp: item?.timestamp || Date.now(),
    session: item?.session,
    project: item?.project,
    payload: item?.payload || {},
  };
}

describe('evaluation framework e2e', () => {
  const base = 'http://localhost:3300';
  const project = 'instrumentMeetingInsight';

  test('fetch datalake items and run metrics', async () => {
    // Load metrics config
    const metricsPath = path.join(__dirname, 'eval.metrics.json');
  // Local metrics file path preserved for evaluateAllFromConfig usage.

    // Fetch flat data for project
    const data = await get(`${base}/api/data?project=${encodeURIComponent(project)}&nest=flat`);
    expect(Array.isArray(data?.items)).toBe(true);
    if (!Array.isArray(data?.items) || data.items.length === 0) {
      console.warn('No items fetched from datalake; skipping eval run');
      return;
    }

    // Take first few items to evaluate
    const sample = data.items.slice(0, 3).map(toLogUnit);

    // Evaluate metrics once across all units
    const evalPath = path.join(__dirname, 'eval.metrics.json');
    const rawResults: any = await Eval.evaluateAllFromConfig(evalPath, sample);
    expect(Array.isArray(rawResults)).toBe(true);
    // New shape: EvaluationResult[] (no per-unit grouping)
    const results = rawResults as EvalTypes.EvaluationResult[];
    for (const r of results) {
      expect(r && typeof r.metric).toBe('string');
      expect(typeof r.success).toBe('boolean');
    }
    const passedCount = results.filter(r => r.success).length;
    // eslint-disable-next-line no-console
    console.log('[eval-results]', JSON.stringify({ project, units: sample.length, passed: passedCount, total: results.length }));
  }, 15000);
});
