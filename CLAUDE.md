# Agents Orchestrator

HTTP API for submitting and tracking AI agent jobs. Built with Bun + TypeScript using the Anthropic Claude Agent SDK.

## Running

```bash
bun run dev   # watch mode
bun run start # production
```

Runtime and package manager: **bun**

The server runs on port **6432** by default.

### Production server (across worktrees)

Use `server.sh` to run the production-like server. It manages a singleton instance — automatically killing any existing one first. Use this for running the main server, not for testing your changes.

```bash
./server.sh                          # start from current worktree
./server.sh /path/to/other-worktree  # switch to a different worktree
./server.sh --dev                    # watch mode
```

PID is stored in `/tmp/agents-orchestrator/server.pid`; logs go to `/tmp/agents-orchestrator/server.log`.

### Testing your changes

Run `dev-server.sh` to start a throwaway dev server on a random port. The script runs in the foreground, prints connection info, and exits — do **NOT** background it with `&`.

```bash
./dev-server.sh                          # start from current worktree
./dev-server.sh /path/to/other-worktree  # start from a specific worktree
./dev-server.sh --stop                   # stop the server for this directory
./dev-server.sh --status                 # check if a server is already running
```

The script outputs a structured block you can parse directly:

```
---DEV-SERVER-INFO---
STATUS=running
URL=http://127.0.0.1:17432
PORT=17432
PID=208778
LOG=/tmp/agents-orchestrator/dev-server-aBcDeF.log
DATA_DIR=/home/user/.dev-agents-orchestrator
WORKTREE=/path/to/worktree
---END-DEV-SERVER-INFO---
```

Multiple dev servers can run simultaneously (each gets a random port in 3100–19999). Servers auto-exit after 4 hours. Re-running in the same directory kills the previous instance.

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
- `GET /events` — SSE stream; pushes `snapshot`, `session_created`, `session_status`, and `chat_entry` events to connected browsers
- `POST /sessions` — submit a session: `{ prompt: string, tools?: string[], cwd?: string }` → `{ id, status: "pending" }`
- `GET /sessions` — list all sessions
- `GET /sessions/:id` — get session status and result
- `POST /sessions/:id/approve` — approve a pending plan
- `POST /sessions/:id/reject` — reject a pending plan
- `POST /sessions/:id/followup` — send a follow-up prompt: `{ prompt: string }`

## Project structure

```
src/
  server.ts        # HTTP server entry point — Bun routes, parseBody helper, SSE /events route
  sessions.ts      # agent runner — session functions, stream processing, tool approval
  schemas.ts       # Zod request schemas (CreateSessionSchema, FollowUpSchema, …)
  store.ts         # in-memory session store with file-system persistence + SSE event emitter
  types.ts         # shared TypeScript interfaces (Session, SessionStatus, ChatEntry, StoreEvent, …)
  public/
    index.html     # management UI markup
    style.css      # management UI styles
    app.js         # management UI — SSE client, incremental DOM updates
```

The management UI is served as static files. `server.ts` reads `index.html` once at startup and serves `style.css` / `app.js` on their respective routes.

**Real-time updates** are delivered over a single persistent SSE connection (`GET /events`). The browser's native `EventSource` API connects on page load and receives three event types:

- `snapshot` — sent once on connect/reconnect; full state of all sessions (bootstraps the UI and handles reconnects)
- `session_status` — fired by every `store.ts` mutation except `appendChat`; carries updated metadata (status, timestamps, result, error, plan, pendingTools)
- `chat_entry` — fired by `store.appendChat`; carries a single `ChatEntry` and its index in the chat array

`session_status` events trigger a full `renderDetail` rebuild for the selected session (infrequent — only on state transitions). `chat_entry` events call `appendChatEntryDOM`, which inserts a single DOM node into `#chat-feed` without rebuilding the panel (happens dozens of times per second during execution). Multiple browser tabs are supported; each holds one SSE connection registered in `store.ts`'s subscriber Set.

## Session lifecycle

`pending → planning → awaiting_approval → running → completed | failed`

Sessions run asynchronously. The browser UI receives live updates via SSE (`GET /events`) — no polling needed. The `chat` array accumulates text and tool call entries as the agent works; each new entry is pushed as a `chat_entry` SSE event. Sessions in the `awaiting_approval` state expose a `plan` field and must be explicitly approved or rejected before execution continues. The additional intermediate statuses `awaiting_tool_approval` and `awaiting_user_question` gate individual tool calls and clarifying questions respectively.
