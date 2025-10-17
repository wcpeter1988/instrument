# datalake

A simple file-backed service to collect and browse arbitrary payloads grouped by project/session/tagid/description.

### Data API
- POST /api/data to store an item
- GET /api/data?project=NAME&nest=flat|session,tagid,description to list items
- DELETE /api/data[?project=NAME] to clear data (dangerous)

### Config API (Versioned)
Project-level configuration stored as incrementing versions under `data/<project>/config/`.

Storage layout:
```
data/<project>/config/v1.json
data/<project>/config/v2.json
...
data/<project>/config/latest.json   # copy of the latest version for convenience
```

Endpoints:
- POST /api/config  body: `{ project, config }` -> creates new version (latest+1) and updates latest.json
- GET /api/config -> lists projects that have at least one config version
- GET /api/config?project=NAME[&version=N] -> returns requested version (or latest if version omitted) plus latest number
- DELETE /api/config?project=NAME[&version=N] -> deletes a specific version (auto-updates latest) or all versions if version omitted

### UI
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

Data is stored under new hierarchy `datalake/data/<project>/<session>/<tagid>/<description>/items.jsonl`.
Back-compat read also understands old hierarchy `datalake/data/<project>/<tagid>/<description>/<session>/items.jsonl`.

### Examples

Post data:
```
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
```

Manage config (versioned):
```
# Create first version (v1)
curl -X POST http://localhost:3300/api/config \
	-H "Content-Type: application/json" \
	-d '{"project":"demo","config":{"thresholds":{"temp":30}}}'

# Create second version (v2)
curl -X POST http://localhost:3300/api/config \
	-H "Content-Type: application/json" \
	-d '{"project":"demo","config":{"thresholds":{"temp":32},"mode":"aggressive"}}'

# Fetch latest (v2)
curl http://localhost:3300/api/config?project=demo

# Fetch specific version v1
curl http://localhost:3300/api/config?project=demo&version=1

# Delete version v1
curl -X DELETE http://localhost:3300/api/config?project=demo&version=1

# Delete all versions
curl -X DELETE http://localhost:3300/api/config?project=demo
```