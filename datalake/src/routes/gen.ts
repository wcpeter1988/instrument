import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { autoGenerateMetrics } from '@workspace/instrument';
import type { LogUnit } from '@workspace/common';

// /api/gen: generate metric config from existing logged data for a project and session list.
// POST body: { project: string, sessions: string[], prompt?: string }
// Steps:
// 1. Load LogUnits for given project+sessions from data/<project>/<session>/**/items.jsonl
// 2. Call autoGenerateMetrics(units, prompt)
// 3. Persist generated metrics as new versioned config via writing to /api/config (reuse logic inline)

export function createGenRouter(DATA_DIR: string) {
  const router = Router();

  function sanitize(s: string) {
    return String(s || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Read all log items for project+session list and convert to LogUnit[]
  function collectUnits(project: string, sessions: string[]): LogUnit[] {
    const units: LogUnit[] = [];
    const projectDir = path.join(DATA_DIR, sanitize(project));
    if (!fs.existsSync(projectDir)) return units;
    for (const session of sessions) {
      const sessionDir = path.join(projectDir, sanitize(session));
      if (!fs.existsSync(sessionDir)) continue;
      // sessionDir/<tagid>/<description>/items.jsonl
      const tagids = fs.readdirSync(sessionDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
      for (const tagid of tagids) {
        const tagDir = path.join(sessionDir, tagid);
        const descs = fs.readdirSync(tagDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
        for (const desc of descs) {
          const file = path.join(tagDir, desc, 'items.jsonl');
          if (!fs.existsSync(file)) continue;
          const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              // Map persisted item shape to LogUnit expected by autogen (best-effort)
              // persisted: { project, session, tagid, description, timestamp, payload }
              const lu: LogUnit = {
                tagId: String(parsed.tagid || parsed.tagId || tagid),
                timestamp: Number(parsed.timestamp) || Date.now(),
                session: parsed.session || session,
                project: parsed.project || project,
                payload: {
                  args: parsed.payload?.args || {},
                  vars: parsed.payload?.vars || {},
                  return: parsed.payload?.return,
                  error: parsed.payload?.error,
                  end: parsed.payload?.end,
                  durationMs: parsed.payload?.durationMs
                }
              };
              units.push(lu);
            } catch {}
          }
        }
      }
    }
    return units;
  }

  // Versioned config helpers (duplicated minimal subset from config router to avoid circular import)
  function configDir(project: string) { return path.join(DATA_DIR, sanitize(project), 'config'); }
  function versionFile(project: string, version: number) { return path.join(configDir(project), `v${version}.json`); }
  function latestFile(project: string) { return path.join(configDir(project), 'latest.json'); }
  function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
  function readLatestVersion(project: string): number | undefined {
    const dir = configDir(project);
    if (!fs.existsSync(dir)) return undefined;
    const files = fs.readdirSync(dir).filter(f => /^v\d+\.json$/.test(f));
    const versions = files.map(f => Number(f.slice(1).replace(/\.json$/, ''))).filter(n => !isNaN(n));
    if (!versions.length) return undefined;
    return Math.max(...versions);
  }

  router.post('/gen', async (req: Request, res: Response) => {
    const { project, sessions, prompt } = req.body || {};
    if (!project || typeof project !== 'string') return res.status(400).json({ ok: false, error: 'project (string) required' });
    if (!Array.isArray(sessions) || !sessions.length) return res.status(400).json({ ok: false, error: 'sessions (string[]) required' });
    try {
      const units = collectUnits(project, sessions.map(String));
      if (!units.length) return res.status(404).json({ ok: false, error: 'No log units found for given sessions' });
      const metrics = await autoGenerateMetrics(units, prompt);
      // Persist as new versioned config
      const cdir = configDir(project);
      ensureDir(cdir);
      const latest = readLatestVersion(project);
      const next = latest === undefined ? 1 : latest + 1;
      const fileData = { version: next, generatedAt: new Date().toISOString(), metrics };
      fs.writeFileSync(versionFile(project, next), JSON.stringify(fileData, null, 2), 'utf8');
      fs.writeFileSync(latestFile(project), JSON.stringify(fileData, null, 2), 'utf8');
      return res.json({ ok: true, project, version: next, metricsCount: metrics.length });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || 'generation failed' });
    }
  });

  return router;
}
