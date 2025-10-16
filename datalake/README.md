# datalake

A simple file-backed service to collect and browse arbitrary payloads grouped by project/tagid/description/session.

- POST /api/data to store an item
- GET /api/data?project=NAME&nest=flat|tagid,description,session to list items
- Web UI served at /

## Run

- Dev: npm run dev -w datalake
- Build: npm run build -w datalake
- Start: npm run start -w datalake

Environment:
- PORT (default 3300)

## Data schema

Required:
- project: string
- timestamp: number (ms) or ISO string

Optional:
- session: string
- tagid: string
- description: string
- payload: any

Data is stored under datalake/data/<project>/<tagid>/<description>/<session>/items.jsonl as JSON lines.