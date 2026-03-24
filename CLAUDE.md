# Agents Orchestrator

HTTP API for submitting and tracking AI agent jobs. Built with Bun + TypeScript using the Anthropic Claude Agent SDK.

## Running

```bash
bun run dev   # watch mode
bun run start # production
```

Runtime and package manager: **bun**

## API

- `POST /jobs` — submit a job: `{ prompt: string, tools?: string[], cwd?: string }` → `{ id, status: "pending" }`
- `GET /jobs` — list all jobs
- `GET /jobs/:id` — get job status and result

## Project structure

```
src/
  server.ts   # HTTP server + agent runner (entry point)
  store.ts    # in-memory job store
  types.ts    # shared interfaces
```

## Job lifecycle

`pending → running → completed | failed`

Jobs run asynchronously. Poll `GET /jobs/:id` to check progress. The `log` field streams text and tool call events as the agent works.
