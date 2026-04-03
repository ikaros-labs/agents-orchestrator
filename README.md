# agents-orchestrator

HTTP API for submitting and tracking AI agent sessions powered by Claude.

## Setup

```bash
bun install
bun run dev
```

## Usage

### Web UI

Open **`http://localhost:3000/`** in your browser for a management UI that lets you:

- Submit sessions and attach images
- Watch session progress in real-time — chat entries stream in as the agent works via SSE (no polling)
- Review the agent's plan before it makes any changes
- Approve or reject plans, approve or deny individual tool calls, answer clarifying questions
- Send follow-up prompts on completed sessions

### API

#### Submit a session

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Review utils.py for bugs and fix any issues you find."}'
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "pending" }
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✓ | Task for the agent |
| `tools` | string[] | | Tools to allow (default: see below) |
| `cwd` | string | | Working directory for the agent |
| `images` | object[] | | Images to attach (see [Images](#images)) |

**Default tools:** `Read`, `Edit`, `Glob`, `Write`, `Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion`

To restrict the tools available:

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Search for TODO comments.", "tools": ["Glob", "Grep"]}'
```

---

#### SSE event stream

```bash
curl -N http://localhost:3000/events
```

Returns a persistent `text/event-stream` response. The browser UI connects here automatically. Three named event types are emitted:

| Event | Payload | When |
|-------|---------|------|
| `snapshot` | Array of all sessions | On every connect / reconnect |
| `session_status` | `{ sessionId, status, startedAt, finishedAt, result, error, plan, pendingTools }` | Any session metadata change |
| `chat_entry` | `{ sessionId, entry, index }` | Each new chat entry appended |

---

#### List all sessions

```bash
curl http://localhost:3000/sessions
```

Returns an array of session objects.

---

#### Get a session

```bash
curl http://localhost:3000/sessions/<id>
```

```json
{
  "id": "20260324T120000000Z-abc-123",
  "status": "completed",
  "prompt": "Review utils.py for bugs and fix any issues you find.",
  "tools": ["Read", "Edit", "Glob", "Write", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"],
  "cwd": "/home/user/myproject",
  "plan": "1. Read utils.py\n2. Identify any bugs...",
  "createdAt": "2026-03-24T12:00:00.000Z",
  "startedAt": "2026-03-24T12:00:01.000Z",
  "finishedAt": "2026-03-24T12:00:15.000Z",
  "chat": [
    { "type": "text", "text": "Reading utils.py...", "ts": "2026-03-24T12:00:02.000Z" },
    { "type": "tool_call", "name": "Read", "input": { "file_path": "utils.py" }, "ts": "2026-03-24T12:00:03.000Z" },
    { "type": "text", "text": "Found an off-by-one error on line 42.", "ts": "2026-03-24T12:00:10.000Z" }
  ],
  "result": "success",
  "error": null,
  "claudeSessionId": "sess_abc123",
  "images": []
}
```

---

#### Approve a plan

Once a session reaches `awaiting_approval`, review the `plan` field and approve it to proceed:

```bash
curl -X POST http://localhost:3000/sessions/<id>/approve
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "running" }
```

---

#### Reject a plan

```bash
curl -X POST http://localhost:3000/sessions/<id>/reject
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "failed" }
```

---

#### Send a follow-up

After a session `completed` (or `failed`), send an additional prompt continuing the same conversation:

```bash
curl -X POST http://localhost:3000/sessions/<id>/followup \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Also add type hints to all functions."}'
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "running" }
```

The follow-up accepts the same `images` field as session creation.

---

## Session Lifecycle

```
pending → planning → awaiting_approval → running → completed
                   ↕                   ↕        ↘ failed
             awaiting_user_question  awaiting_tool_approval
```

| Status | Description |
|--------|-------------|
| `pending` | Session accepted, not yet started |
| `planning` | Agent is drafting a plan (read-only) |
| `awaiting_approval` | Plan ready — waiting for human approval or rejection |
| `awaiting_tool_approval` | Agent wants to invoke a tool — waiting for human approval |
| `awaiting_user_question` | Agent asked a clarifying question — waiting for answers |
| `running` | Plan is being executed |
| `completed` | Session finished successfully |
| `failed` | Session failed or plan was rejected |

The two-phase model means the agent first produces a plan without making any changes, giving you a chance to review and approve before anything is modified. During execution, tool calls and clarifying questions can also be gated on human approval.

---

## Chat Entry Types

Each entry in the `chat` array has a `type` field:

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `text`, `ts` | Narrative output from the agent |
| `tool_call` | `name`, `input`, `ts` | A tool invocation with its inputs |
| `image` | `mediaType`, `url`, `ts` | An image produced by the agent |

---

## Images

Attach images to a session by base64-encoding them:

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Describe what is wrong with this screenshot.",
    "images": [
      {
        "mediaType": "image/png",
        "data": "<base64-encoded image data>"
      }
    ]
  }'
```

Supported media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

Saved images are served at `GET /images/:sessionId/:filename`.

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `localhost` | Hostname to bind |
| `ANTHROPIC_API_KEY` | — | Required for the agent to run |
