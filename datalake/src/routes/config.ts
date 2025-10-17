import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

// Versioned project-level configuration management.
// Stored at: data/<project>/config/v<N>.json (auto-incremented) + latest.json symlink/copy.
// Schema is user-defined; we only store and retrieve JSON.

export function createConfigRouter(DATA_DIR: string) {
  const router = Router();

  function sanitize(s: string) {
    return String(s || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function projectDir(project: string) {
    return path.join(DATA_DIR, sanitize(project));
  }

  function configDir(project: string) {
    return path.join(projectDir(project), 'config');
  }

  function versionFile(project: string, version: number) {
    return path.join(configDir(project), `v${version}.json`);
  }

  function latestFile(project: string) {
    return path.join(configDir(project), 'latest.json');
  }

  function readLatestVersion(project: string): number | undefined {
    const dir = configDir(project);
    if (!fs.existsSync(dir)) return undefined;
    // versions are vN.json; parse and return max N
    const files = fs.readdirSync(dir).filter(f => /^v\d+\.json$/.test(f));
    const versions = files.map(f => Number(f.slice(1).replace(/\.json$/, ''))).filter(n => !isNaN(n));
    if (!versions.length) return undefined;
    return Math.max(...versions);
  }

  function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  // GET /api/config -> list projects that have any version OR if project query given, return latest or requested version
  // Optional query: version=<number>
  router.get('/config', (req: Request, res: Response) => {
    const project = (req.query.project as string) || undefined;
    const versionParam = req.query.version !== undefined ? Number(req.query.version) : undefined;
    if (!project) {
      // list projects that have config dir with at least one version
      const projects: string[] = [];
      if (fs.existsSync(DATA_DIR)) {
        for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cdir = path.join(DATA_DIR, entry.name, 'config');
          if (fs.existsSync(cdir)) {
            const hasVersion = fs.readdirSync(cdir).some(f => /^v\d+\.json$/.test(f));
            if (hasVersion) projects.push(entry.name);
          }
        }
      }
      return res.json({ ok: true, projects });
    }
    const latest = readLatestVersion(project);
    if (latest === undefined) return res.status(404).json({ ok: false, error: 'config not found' });
    const version = versionParam !== undefined ? versionParam : latest;
    if (versionParam !== undefined && versionParam > latest) {
      return res.status(404).json({ ok: false, error: 'requested version not found' });
    }
    const file = versionFile(project, version);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'version file missing' });
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const config = JSON.parse(raw);
      return res.json({ ok: true, project, version, latest, config });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'failed to read config' });
    }
  });

  // POST /api/config body { project, config } -> create new version (latest+1)
  router.post('/config', (req: Request, res: Response) => {
    const { project, config } = req.body || {};
    if (!project || typeof project !== 'string')
      return res.status(400).json({ ok: false, error: 'project (string) is required' });
    if (config === undefined) return res.status(400).json({ ok: false, error: 'config is required' });
    try {
      const cdir = configDir(project);
      ensureDir(cdir);
      const latest = readLatestVersion(project);
      const next = latest === undefined ? 1 : latest + 1;
      const file = versionFile(project, next);
      fs.writeFileSync(file, JSON.stringify({ version: next, config }, null, 2), 'utf8');
      // update latest.json copy for convenience
      fs.writeFileSync(latestFile(project), JSON.stringify({ version: next, config }, null, 2), 'utf8');
      return res.json({ ok: true, project, version: next, latest: next });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'failed to write config' });
    }
  });

  // DELETE /api/config?project=NAME[&version=N] -> remove a specific version or all versions if version omitted
  router.delete('/config', (req: Request, res: Response) => {
    const project = (req.query.project as string) || undefined;
    const versionParam = req.query.version !== undefined ? Number(req.query.version) : undefined;
    if (!project) return res.status(400).json({ ok: false, error: 'project query is required' });
    const latest = readLatestVersion(project);
    if (latest === undefined) return res.json({ ok: true, project, removed: false });
    const cdir = configDir(project);
    if (versionParam !== undefined) {
      if (versionParam > latest || versionParam < 1) {
        return res.status(404).json({ ok: false, error: 'version not found' });
      }
      const file = versionFile(project, versionParam);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      // recompute latest after deletion
      const newLatest = readLatestVersion(project);
      if (newLatest !== undefined) {
        const latestDataRaw = fs.readFileSync(versionFile(project, newLatest), 'utf8');
        fs.writeFileSync(latestFile(project), latestDataRaw, 'utf8');
      } else if (fs.existsSync(latestFile(project))) {
        fs.unlinkSync(latestFile(project));
      }
      return res.json({ ok: true, project, removed: true, version: versionParam, latest: newLatest });
    } else {
      // remove entire config directory
      if (fs.existsSync(cdir)) {
        for (const f of fs.readdirSync(cdir)) fs.unlinkSync(path.join(cdir, f));
        fs.rmdirSync(cdir);
      }
      return res.json({ ok: true, project, removed: true, all: true });
    }
  });

  return router;
}
