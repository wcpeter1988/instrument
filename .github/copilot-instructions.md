# AI coding agents: quickstart for this repo

This monorepo hosts three packages:
- `instrument`: a small TS library providing function/class/method logging wrappers
- `testbed`: a simple app that consumes `@workspace/instrument` to demonstrate usage
- `datalake`: a file-backed Express service exposing a tiny data ingest/list API and a minimal web UI

## Architecture and data flow
- `instrument` exports three entry points from `instrument/src/index.ts`:
  - `logCall(fn, options)` wraps a function, logging args/return/throw, handling async promises
  - `@LogMethod()` and `@LogAll()` decorators instrument methods/classes respectively
  - Options include `label`, `includeThis`, and `redact` for JSON.stringify redaction
- `testbed` shows usage in `testbed/src/service.ts` and runs via `testbed/src/index.ts`.
- `datalake` (`datalake/src/index.ts`) is an Express server with endpoints:
  - POST `/api/data` accepts a JSON body `{ project, session?, tagid?, description?, timestamp, payload? }`
    - Required: `project` (string), `timestamp` (number ms since epoch or ISO string)
    - Persists to `datalake/data/<project>/<session>/<tagid>/<description>/items.jsonl` as JSONL
    - Notes: within a session, `tagid` should be unique and `description` is a 1:1 human-readable label for that tagid
  - GET `/api/data`
    - Required query: `project=NAME`
    - Optional filters: `session=NAME`, `tagid=NAME`
    - Optional `nest`:
      - `flat` returns `{ project, items[] }`
      - default or `session,tagid,description` returns `{ project, nest: 'session>tagid>description', filters, data }`, where `data[session][tagid][description] = items[]`
  - DELETE `/api/data`
    - Clear all data under the datalake `data/` directory (preserves the root folder)
    - `DELETE /api/data?project=NAME` clears only the specified project
  - Static web UI served at `/` from `datalake/src/public/index.html`

## Build, run, debug
- Root uses npm workspaces. Key scripts in root `package.json`:
  - `npm run build` builds all packages (`tsc -b` per package)
  - `npm run clean` cleans each package
  - `npm run start` runs testbed
  - `npm run start:datalake` / `npm run dev:datalake` run the service
- Per-package:
  - `instrument`: `tsc -b` outputs to `instrument/dist` (published files only in `dist/`)
  - `testbed`: `ts-node src/index.ts` for dev; `node dist/index.js` for start
  - `datalake`: `ts-node src/index.ts` for dev; `node dist/index.js` for start; static assets copied on build via `postbuild`.
- TypeScript project references are defined in root `tsconfig.json`; shared compiler options are in `tsconfig.base.json`.

## Conventions and patterns
- TypeScript target: ES2020, CommonJS modules across packages.
- `instrument` prefers non-throwing stringification via helpers `formatArgs`/`safeStringify` with optional `redact` callback.
- Decorators require `experimentalDecorators` (enabled in `tsconfig.base.json`).
- `datalake` storage is directory-structured JSONL files.
  - New hierarchy: `<project>/<session>/<tagid>/<description>/items.jsonl`
  - Paths are sanitized to `[a-zA-Z0-9._-]`, replacing others with `_`.
  - Back-compat read: old hierarchy `<project>/<tagid>/<description>/<session>/items.jsonl` is also understood when listing.
- `datalake` UI uses plain HTML/JS; it loads lists via `/api/data` and renders nested (session → tagid/description) or flat views.
- changes to `datalake` never requires manual restart; it auto rebuilds on source changes in dev mode.
- As agent you should never start/restart datalake, consider it always running.
- As agent you should never start webui http://localhost:3300, consider it always running.

## Examples
- Instrument a function in consumers:
  ```ts
  import { logCall } from '@workspace/instrument';
  const add = (a: number, b: number) => a + b;
  const logged = logCall(add, { label: 'add' });
  logged(1, 2);
  ```
- Send data to datalake (curl):
  ```sh
  # POST a temperature reading
  curl -X POST http://localhost:3300/api/data \
    -H "Content-Type: application/json" \
    -d '{
      "project":"demo",
      "session":"s1",
      "tagid":"sensor_t",
      "description":"temp",
      "timestamp": 1710000000000,
      "payload": {"c": 22.5}
    }'

  # POST a humidity reading
  curl -X POST http://localhost:3300/api/data \
    -H "Content-Type: application/json" \
    -d '{
      "project":"demo",
      "session":"s1",
      "tagid":"sensor_h",
      "description":"humidity",
      "timestamp": "2024-03-09T00:00:00.000Z",
      "payload": {"pct": 48}
    }'
  ```

- List data (flat):
  `GET http://localhost:3300/api/data?project=demo&nest=flat`

- List data (nested):
  - Project only: `GET /api/data?project=demo`
  - Project + tagid: `GET /api/data?project=demo&tagid=sensor_h`
  - Project + session: `GET /api/data?project=demo&session=s1`
  - Project + session + tagid: `GET /api/data?project=demo&session=s1&tagid=sensor_h`

- Clear data (dangerous):
  - All projects: `DELETE http://localhost:3300/api/data`
  - Single project: `DELETE http://localhost:3300/api/data?project=demo`

## Gotchas and notes
- Ensure dependencies for `datalake` are installed (Express + types). Root `npm install` should hoist them.
- When building `datalake`, static UI files under `src/public` are copied to `dist/` via `copyfiles` in `postbuild`.
- The service default port is 3300. Override with `PORT` env.

## Where to look first
- Library API: `instrument/src/index.ts`
- Service endpoints + storage: `datalake/src/index.ts`
- UI entry: `datalake/src/public/index.html`
- Testbed usage: `testbed/src/service.ts`, `testbed/src/index.ts`
