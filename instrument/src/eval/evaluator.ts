import type { MetricConfig, EvaluationResult, LLM, MethodologyType } from './types';
import { getByPath, projectInputs } from './query';
import type { LogUnit } from '@workspace/common';
import { DAG } from './methodologies/dag';
import { QAG } from './methodologies/qag';
import { StringMatch } from './methodologies/string_match';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

/**
 * Metric evaluation utilities.
 *
 * Config source options:
 * 1. Local JSON file path (absolute or relative) containing an array of MetricConfig objects.
 * 2. Remote datalake config via shorthand: "<project>:<versionSpec>" where versionSpec is a number or "latest".
 *    - Example: "demo:latest" or "demo:2"
 *    - Performs GET to `${DATALAKE_URL||'http://localhost:3300'}/api/config?project=demo[&version=2]`
 *    - Response normalization handles shapes produced by /api/config and /api/gen:
 *        { ok, config: { metrics: [...] } }
 *        { ok, metrics: [...] }
 *        { ok, config: [...] } (raw array)
 *        { ok, config: { config: { metrics: [...] } } } (nested wrapper)
 *
 * The evaluateAll overload automatically detects the shorthand based on pattern /^[^:\\]+:(latest|\d+)$/.
 */

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

// Build a tag-indexed context: { <tagId>: { return, args, vars, ...payload } }
function buildTagContext(units: LogUnit[]) {
  const ctx: Record<string, any> = {};
  for (const u of units) {
    ctx[u.tagId] = { ...u.payload };
  }
  return ctx;
}

// For backward compatibility, allow legacy expressions starting with 'payload.' which refer to current unit's payload
function remapLegacy(expr: string, fallbackUnit?: LogUnit): string {
  if (expr.startsWith('payload.') && fallbackUnit) {
    return `${fallbackUnit.tagId}.${expr.substring('payload.'.length)}`;
  }
  return expr;
}

export async function evaluateMetric(metric: MetricConfig, allUnits: LogUnit[], llm: LLM = new MockLLM()): Promise<EvaluationResult> {
  const m = REGISTRY[metric.methodology as MethodologyType];
  if (!m) return { metric: metric.name, success: false, error: `Unknown methodology: ${metric.methodology}` };
  const tagCtx = buildTagContext(allUnits);
  const fallback = allUnits[0];
  const remapped: Record<string, string> = {};
  for (const [k, v] of Object.entries(metric.query || {})) {
    remapped[k] = remapLegacy(v, fallback);
  }
  const inputs: Record<string, any> = {};
  for (const [k, expr] of Object.entries(remapped)) {
    inputs[k] = getByPath(tagCtx, expr);
  }
  try {
    return await m.evaluate({ metric, inputs, llm });
  } catch (err: any) {
    return { metric: metric.name, success: false, error: err?.message || String(err) };
  }
}

// Overload signatures
export async function evaluateAll(metrics: MetricConfig[], units: LogUnit[], llm?: LLM): Promise<EvaluationResult[]>;
export async function evaluateAll(configPath: string, units: LogUnit[], llm?: LLM): Promise<EvaluationResult[]>;

/**
 * evaluateAll(localMetrics, units[]) -> EvaluationResult[] (each metric evaluated once across all units)
 * evaluateAll(configPath|stringSpec, units[]) -> EvaluationResult[]
 * Shorthand remote spec: "project:latest" or "project:1".
 */
export async function evaluateAll(a: any, b: any, c: any = new MockLLM()): Promise<any> {
  const llm: LLM = c || new MockLLM();
  // Support remote datalake config fetch via syntax: "<project>:<versionSpec>"
  // versionSpec can be a number or the literal "latest". Example: "demo:latest" or "demo:2".
  // This will call GET http://localhost:3300/api/config?project=demo[&version=2]
  // Returned JSON forms we normalize to MetricConfig[]:
  // 1. { ok, config: { metrics: [...]} }
  // 2. { ok, config: { config: { metrics: [...] } } } (manual post wrapper)
  // 3. { ok, config: [...] } (raw array)
  // 4. { ok, metrics: [...] } (future proof)
  async function fetchRemoteMetrics(spec: string): Promise<MetricConfig[]> {
    return fetchRemoteMetricsBase(spec, process.env.DATALAKE_URL || 'http://localhost:3300');
  }
  // New signature: (configPath: string, units: LogUnit[])
  if (typeof a === 'string' && Array.isArray(b)) {
    const configPath = path.isAbsolute(a) ? a : path.join(process.cwd(), a);
    let raw: string;
    let metrics: MetricConfig[] | undefined;
    // Detect remote spec
    if (/^[^:\\]+:(latest|\d+)$/.test(a)) {
      metrics = await fetchRemoteMetrics(a);
    } else {
      try {
        raw = fs.readFileSync(configPath, 'utf8');
      } catch (err: any) {
        throw new Error(`Failed to read metrics config at ${configPath}: ${err?.message || err}`);
      }
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('Metrics JSON must be an array');
        metrics = parsed as MetricConfig[];
      } catch (err: any) {
        throw new Error(`Failed to parse metrics JSON (${configPath}): ${err?.message || err}`);
      }
    }
    const unitsArr = b as LogUnit[];
    const out: EvaluationResult[] = [];
    for (const metric of metrics!) {
      out.push(await evaluateMetric(metric, unitsArr, llm));
    }
    return out;
  }
  // Direct metrics array case: (metrics[], units[])
  if (Array.isArray(a) && Array.isArray(b)) {
    const metrics: MetricConfig[] = a;
    const unitsArr: LogUnit[] = b;
    const out: EvaluationResult[] = [];
    for (const metric of metrics) {
      out.push(await evaluateMetric(metric, unitsArr, llm));
    }
    return out;
  }
  throw new Error('Invalid evaluateAll arguments');
}

// Explicit helper to avoid overload resolution issues in TS consumer code
export async function evaluateAllFromConfig(configPath: string, units: LogUnit[], llm: LLM = new MockLLM()) {
  return evaluateAll(configPath, units, llm) as Promise<EvaluationResult[]>;
}

// Base fetch implementation extracted for re-use in EvalClient
export async function fetchRemoteMetricsBase(spec: string, baseUrl: string): Promise<MetricConfig[]> {
  const m = /^([^:]+):(latest|\d+)$/;
  const match = spec.match(m);
  if (!match) throw new Error(`Invalid remote spec: ${spec}`);
  const project = match[1];
  const versionSpec = match[2];
  const base = baseUrl || 'http://localhost:3300';
  const url = new URL(base.replace(/\/$/, '') + '/api/config');
  url.searchParams.set('project', project);
  if (versionSpec !== 'latest') url.searchParams.set('version', versionSpec);
  const useFetch: boolean = typeof (globalThis as any).fetch === 'function';
  let body: any;
  try {
    if (useFetch) {
      const resp = await (globalThis as any).fetch(url.toString(), { method: 'GET' });
      body = await resp.json();
    } else {
      body = await new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.get(url, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
      });
    }
  } catch (err: any) {
    throw new Error(`Remote fetch failed (${url.toString()}): ${err?.message || err}`);
  }
  if (!body || body.ok === false) {
    throw new Error(`Config fetch error for ${project}:${versionSpec} - ${body?.error || 'unknown'}`);
  }
  // Print version info if available
  if (typeof body.version === 'number' || typeof body.latest === 'number') {
    // eslint-disable-next-line no-console
    console.log('[eval-config]', JSON.stringify({ project, requested: versionSpec, version: body.version, latest: body.latest }));
  } else if (body.config && (typeof body.config.version === 'number')) {
    // eslint-disable-next-line no-console
    console.log('[eval-config]', JSON.stringify({ project, requested: versionSpec, version: body.config.version }));
  }
  const cfg = body.config;
  let metrics: any;
  if (Array.isArray(body.metrics)) metrics = body.metrics;
  else if (cfg?.metrics && Array.isArray(cfg.metrics)) metrics = cfg.metrics;
  else if (cfg?.config?.metrics && Array.isArray(cfg.config.metrics)) metrics = cfg.config.metrics;
  else if (Array.isArray(cfg)) metrics = cfg;
  if (!metrics) throw new Error('No metrics array found in remote config response');
  return metrics as MetricConfig[];
}

export class EvalClient {
  constructor(public baseUrl: string = 'http://localhost:3300', public llm: LLM = new MockLLM()) {}

  async loadMetrics(spec: string): Promise<MetricConfig[]> {
    if (!/^([^:]+):(latest|\d+)$/.test(spec)) {
      throw new Error('EvalClient.loadMetrics expects project:versionSpec (latest|number)');
    }
    return fetchRemoteMetricsBase(spec, this.baseUrl);
  }

  async evaluate(spec: string, units: LogUnit[]): Promise<EvaluationResult[]> {
    const metrics = await this.loadMetrics(spec);
    const out: EvaluationResult[] = [];
    for (const m of metrics) {
      out.push(await evaluateMetric(m, units, this.llm));
    }
    return out;
  }
}

/**
 * Usage example:
 * const client = new EvalClient('http://localhost:3300');
 * const results = await client.evaluate('demo:latest', logUnits);
 * results => [{ metric, success, ... }, ...] (each metric evaluated once over all units context)
 */

// Pretty-print evaluation results as a single-row table: metrics are columns; cell shows PASS/FAIL.
// Cells intentionally avoid the word 'detail' per requirement.
export function printEvaluationTable(results: EvaluationResult[]): void {
  if (!Array.isArray(results) || !results.length) {
    // eslint-disable-next-line no-console
    console.log('[eval-table] <no results>');
    return;
  }
  const headers = results.map(r => r.metric);
  const statusRow = results.map(r => (r.success ? 'PASS' : 'FAIL'));
  const colWidths = headers.map((h, i) => Math.max(h.length, statusRow[i].length));
  function pad(s: string, w: number) { return s.padEnd(w, ' '); }
  const headerLine = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
  const sepLine = '|-' + colWidths.map(w => '-'.repeat(w)).join('-|-') + '-|';
  const statusLine = '| ' + statusRow.map((c, i) => pad(c, colWidths[i])).join(' | ') + ' |';
  // eslint-disable-next-line no-console
  console.log('[eval-table]\n' + headerLine + '\n' + sepLine + '\n' + statusLine);
}
