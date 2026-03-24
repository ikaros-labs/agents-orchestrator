# Agents Orchestrator

HTTP API for submitting and tracking AI agent jobs. Built with Bun + TypeScript using the Anthropic Claude Agent SDK.

## Running

```bash
bun run dev   # watch mode
bun run start # production
```

Runtime and package manager: **bun**

## API

- `GET /` — management UI
- `GET /style.css`, `GET /app.js` — static assets for the UI
- `POST /jobs` — submit a job: `{ prompt: string, tools?: string[], cwd?: string }` → `{ id, status: "pending" }`
- `GET /jobs` — list all jobs
- `GET /jobs/:id` — get job status and result
- `POST /jobs/:id/approve` — approve a pending plan
- `POST /jobs/:id/reject` — reject a pending plan
- `POST /jobs/:id/followup` — send a follow-up prompt: `{ prompt: string }`

## Project structure

```
src/
  server.ts        # HTTP server + agent runner (entry point)
  store.ts         # in-memory job store
  types.ts         # shared interfaces
  public/
    index.html     # management UI markup
    style.css      # management UI styles
    app.js         # management UI client-side logic
```

The management UI is served as static files. `server.ts` reads `index.html` once at startup and serves `style.css` / `app.js` on their respective routes. All dynamic content in the UI is fetched client-side via the JSON API.

## Job lifecycle

`pending → planning → awaiting_approval → running → completed | failed`

Jobs run asynchronously. Poll `GET /jobs/:id` to check progress. The `log` field streams text and tool call events as the agent works. Jobs in the `awaiting_approval` state expose a `plan` field and must be explicitly approved or rejected before execution continues.
