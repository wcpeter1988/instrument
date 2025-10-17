import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

// Data shape
// { project, session, tagid, description, timestamp, payload }
// Storage hierarchy (new): data/<project>/<session>/<tagid>/<description>/items.jsonl
// Back-compat read: also understands old hierarchy data/<project>/<tagid>/<description>/<session>/items.jsonl

export function createDataRouter(DATA_DIR: string) {
  const router = Router();

  function ensureDir(p: string) {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }

  function sanitize(s: string) {
    return String(s || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Persist an item to file storage under data/<project>/<session>/<tagid>/<description>/items.jsonl
  function persistData(item: any) {
    const { project, session = 'default', tagid = 'default', description = 'default' } = item;
    const dir = path.join(
      DATA_DIR,
      sanitize(project),
      sanitize(session),
      sanitize(tagid),
      sanitize(description)
    );
    ensureDir(dir);
    const file = path.join(dir, 'items.jsonl');
    // Special override semantics for annotations: always replace existing with latest payload
    const isAnnotations = tagid === 'annotations' && description === 'annotations';
    if (isAnnotations) {
      const incoming = item?.payload?.annotations && typeof item.payload.annotations === 'object' ? item.payload.annotations : {};
      const normalized: Record<string, string> = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (typeof v === 'string') normalized[k] = v;
      }
      const overrideItem = {
        project,
        session,
        tagid,
        description,
        timestamp: item.timestamp,
        payload: { annotations: normalized }
      };
      fs.writeFileSync(file, JSON.stringify(overrideItem) + '\n', 'utf8');
      return;
    }
    const line = JSON.stringify(item) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  }

  function isValidItem(body: any): { ok: boolean; error?: string } {
    const required = ['project', 'timestamp'];
    for (const k of required) {
      if (!(k in body)) return { ok: false, error: `Missing required field: ${k}` };
    }
    if (typeof body.project !== 'string' || !body.project)
      return { ok: false, error: 'project must be non-empty string' };
    if (typeof body.timestamp !== 'number' && typeof body.timestamp !== 'string')
      return { ok: false, error: 'timestamp must be number or ISO string' };
    return { ok: true };
  }

  // POST /api/data
  router.post('/data', (req: Request, res: Response) => {
    const body = req.body;
    const valid = isValidItem(body);
    if (!valid.ok) return res.status(400).json({ error: valid.error });

    const item = {
      project: body.project,
      session: body.session ?? 'default',
      tagid: body.tagid ?? 'default',
      description: body.description ?? 'default',
      timestamp: body.timestamp,
      payload: body.payload ?? null
    };

    try {
      persistData(item);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error('persist error', err);
      return res.status(500).json({ error: 'Failed to persist data' });
    }
  });

  // recursive remove returning count of removed entries
  function rmrf(targetPath: string): number {
    let count = 0;
    if (!fs.existsSync(targetPath)) return count;
    const stat = fs.lstatSync(targetPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(targetPath);
      for (const entry of entries) {
        count += rmrf(path.join(targetPath, entry));
      }
      fs.rmdirSync(targetPath);
      count++;
    } else {
      fs.unlinkSync(targetPath);
      count++;
    }
    return count;
  }

  // DELETE /api/data[?project=NAME]
  router.delete('/data', (req: Request, res: Response) => {
    const project = (req.query.project as string) || undefined;
    try {
      if (project) {
        const projectDir = path.join(DATA_DIR, sanitize(project));
        if (!fs.existsSync(projectDir))
          return res.json({ ok: true, cleared: 'project', project, removed: 0 });
        const removed = rmrf(projectDir);
        return res.json({ ok: true, cleared: 'project', project, removed });
      } else {
        // Clear contents of DATA_DIR but keep the folder
        let removed = 0;
        const entries = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
        for (const name of entries) {
          removed += rmrf(path.join(DATA_DIR, name));
        }
        return res.json({ ok: true, cleared: 'all', removed });
      }
    } catch (err) {
      console.error('clear error', err);
      return res.status(500).json({ error: 'Failed to clear data' });
    }
  });

  // helpers
  function readJSONL(file: string): any[] {
    const items: any[] = [];
    if (!fs.existsSync(file)) return items;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {}
    }
    return items;
  }

  type ReadFilters = { session?: string; tagid?: string };

  // Read data from disk, supporting both new (session/tagid/description) and old (tagid/description/session) layouts.
  function readProjectData(project: string, filters: ReadFilters = {}) {
    const projectDir = path.join(DATA_DIR, sanitize(project));
    if (!fs.existsSync(projectDir)) return {};

    const result: Record<string, Record<string, Record<string, any[]>>> = {};
    const seenFiles = new Set<string>();

    // Helper to add items
    function add(session: string, tagid: string, desc: string, file: string) {
      if (seenFiles.has(file)) return; // avoid duplicates if structures overlap
      const items = readJSONL(file);
      if (!items.length) return;
      if (filters.session && sanitize(filters.session) !== session) return;
      if (filters.tagid && sanitize(filters.tagid) !== tagid) return;
      if (!result[session]) result[session] = {};
      if (!result[session][tagid]) result[session][tagid] = {};
      if (!result[session][tagid][desc]) result[session][tagid][desc] = [];
      result[session][tagid][desc].push(...items);
      seenFiles.add(file);
    }

    // Top-level directories under project (could be session in new layout or tagid in old layout)
    const top = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Helper to test if a top dir matches new layout (session) by peeking an item
    function looksLikeSession(topName: string): boolean {
      try {
        const sessDir = path.join(projectDir, topName);
        const tagids = fs
          .readdirSync(sessDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const tag of tagids) {
          const tagDir = path.join(sessDir, tag);
          const descs = fs
            .readdirSync(tagDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          for (const desc of descs) {
            const file = path.join(tagDir, desc, 'items.jsonl');
            if (!fs.existsSync(file)) continue;
            const items = readJSONL(file);
            if (!items.length) continue;
            const first = items[0];
            if (first && sanitize(first.session) === topName) return true;
            // if we find a mismatch, treat as not a session
            return false;
          }
        }
      } catch {}
      return false;
    }

    // First, traverse those that are confirmed sessions (new layout)
    const sessionTop = top.filter((name) => looksLikeSession(name));
    for (const sess of sessionTop) {
      const sessDir = path.join(projectDir, sess);
      const tagids = fs
        .readdirSync(sessDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const tag of tagids) {
        const tagDir = path.join(sessDir, tag);
        const descs = fs
          .readdirSync(tagDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const desc of descs) {
          const file = path.join(tagDir, desc, 'items.jsonl');
          if (fs.existsSync(file)) add(sess, tag, desc, file);
        }
      }
    }

    // Then, treat the remaining top-level directories as old layout tagids
    const oldTop = top.filter((name) => !sessionTop.includes(name));
    for (const tag of oldTop) {
      const tagDir = path.join(projectDir, tag);
      const descs = fs
        .readdirSync(tagDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const desc of descs) {
        const descDir = path.join(tagDir, desc);
        const sessList = fs
          .readdirSync(descDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const sess of sessList) {
          const file = path.join(descDir, sess, 'items.jsonl');
          if (fs.existsSync(file)) add(sess, tag, desc, file);
        }
      }
    }

    return result;
  }

  // GET /api/data?project=...&nest=session,tagid,description|flat&session=...&tagid=...
  // Supported list combos:
  // 1) project only
  // 2) project + tagid
  // 3) project + session
  // 4) project + session + tagid
  router.get('/data', (req: Request, res: Response) => {
    const project = req.query.project as string;
    const nest = (req.query.nest as string) || 'session,tagid,description';
    const qSession = (req.query.session as string) || undefined;
    const qTag = (req.query.tagid as string) || undefined;
    if (!project) return res.status(400).json({ error: 'project query is required' });

    const data = readProjectData(project, { session: qSession, tagid: qTag });
    if (nest === 'flat') {
      // flatten into array
      const items: any[] = [];
      for (const session of Object.keys(data)) {
        for (const tagid of Object.keys(data[session])) {
          for (const desc of Object.keys(data[session][tagid])) {
            items.push(...data[session][tagid][desc]);
          }
        }
      }
      return res.json({ project, items });
    }

    // Default nesting session -> tagid -> description
    return res.json({
      project,
      nest: 'session>tagid>description',
      filters: { session: qSession, tagid: qTag },
      data
    });
  });

  return router;
}
