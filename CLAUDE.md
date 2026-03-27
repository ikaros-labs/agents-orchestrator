# Agents Orchestrator

HTTP API for submitting and tracking AI agent jobs. Built with Bun + TypeScript using the Anthropic Claude Agent SDK.

## Running

```bash
bun run dev   # watch mode
bun run start # production
```

Runtime and package manager: **bun**

The server is running at **http://100.81.181.2:6432/**

### Production server (across worktrees)

Use `server.sh` to run the production-like server. It manages a singleton instance — automatically killing any existing one first. Use this for running the main server, not for testing your changes.

```bash
./server.sh                          # start from current worktree
./server.sh /path/to/other-worktree  # switch to a different worktree
./server.sh --dev                    # watch mode
```

PID is stored in `/tmp/agents-orchestrator.pid`; logs go to `/tmp/agents-orchestrator.log`.

### Testing your changes

After finishing a task, use `dev-server.sh` — it starts a throwaway dev server on a random port so it never conflicts with anything else. Multiple can run simultaneously.

```bash
./dev-server.sh                          # start from current worktree
./dev-server.sh /path/to/other-worktree  # start from a specific worktree
```

This picks a random port in the 3100–19999 range, installs deps, starts bun in watch mode, and auto-exits after 4 hours. The URL is printed on startup.

### Browser/UI testing

Use the `playwright-cli` skill for any browser-based testing or UI interaction. Run it directly — do not invoke via `npx` or `bunx`:

```bash
playwright-cli <args>
```

### General notes

- Before looking up or using anything from `node_modules` (imports, types, CLI tools), always run `bun i` first to ensure dependencies are installed.

## API

- `GET /` — management UI
- `GET /style.css`, `GET /app.js` — static assets for the UI
- `GET /events` — SSE stream; pushes `snapshot`, `job_created`, `job_status`, and `log_entry` events to connected browsers
- `POST /jobs` — submit a job: `{ prompt: string, tools?: string[], cwd?: string }` → `{ id, status: "pending" }`
- `GET /jobs` — list all jobs
- `GET /jobs/:id` — get job status and result
- `POST /jobs/:id/approve` — approve a pending plan
- `POST /jobs/:id/reject` — reject a pending plan
- `POST /jobs/:id/followup` — send a follow-up prompt: `{ prompt: string }`

## Project structure

```
src/
  server.ts        # HTTP server entry point — Bun routes, parseBody helper, SSE /events route
  jobs.ts          # agent runner — job functions, stream processing, tool approval
  schemas.ts       # Zod request schemas (CreateJobSchema, FollowUpSchema, …)
  store.ts         # in-memory job store with file-system persistence + SSE event emitter
  types.ts         # shared TypeScript interfaces (Job, JobStatus, LogEntry, StoreEvent, …)
  public/
    index.html     # management UI markup
    style.css      # management UI styles
    app.js         # management UI — SSE client, incremental DOM updates
```

The management UI is served as static files. `server.ts` reads `index.html` once at startup and serves `style.css` / `app.js` on their respective routes.

**Real-time updates** are delivered over a single persistent SSE connection (`GET /events`). The browser's native `EventSource` API connects on page load and receives three event types:

- `snapshot` — sent once on connect/reconnect; full state of all jobs (bootstraps the UI and handles reconnects)
- `job_status` — fired by every `store.ts` mutation except `appendLog`; carries updated metadata (status, timestamps, result, error, plan, pendingTools)
- `log_entry` — fired by `store.appendLog`; carries a single `LogEntry` and its index in the log array

`job_status` events trigger a full `renderDetail` rebuild for the selected job (infrequent — only on state transitions). `log_entry` events call `appendLogEntryDOM`, which inserts a single DOM node into `#log-feed` without rebuilding the panel (happens dozens of times per second during execution). Multiple browser tabs are supported; each holds one SSE connection registered in `store.ts`'s subscriber Set.

## Job lifecycle

`pending → planning → awaiting_approval → running → completed | failed`

Jobs run asynchronously. The browser UI receives live updates via SSE (`GET /events`) — no polling needed. The `log` array accumulates text and tool call entries as the agent works; each new entry is pushed as a `log_entry` SSE event. Jobs in the `awaiting_approval` state expose a `plan` field and must be explicitly approved or rejected before execution continues. The additional intermediate statuses `awaiting_tool_approval` and `awaiting_user_question` gate individual tool calls and clarifying questions respectively.
