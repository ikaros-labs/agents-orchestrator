# agents-orchestrator

HTTP API for submitting and tracking AI agent jobs powered by Claude.

## Setup

```bash
bun install
bun run dev
```

## Usage

### Web UI

Open **`http://localhost:3000/`** in your browser for a management UI that lets you:

- Submit jobs and attach images
- Watch job progress in real-time — log entries stream in as the agent works via SSE (no polling)
- Review the agent's plan before it makes any changes
- Approve or reject plans, approve or deny individual tool calls, answer clarifying questions
- Send follow-up prompts on completed jobs

### API

#### Submit a job

```bash
curl -X POST http://localhost:3000/jobs \
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
curl -X POST http://localhost:3000/jobs \
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
| `snapshot` | Array of all jobs | On every connect / reconnect |
| `job_status` | `{ jobId, status, startedAt, finishedAt, result, error, plan, pendingTools }` | Any job metadata change |
| `log_entry` | `{ jobId, entry, index }` | Each new log entry appended |

---

#### List all jobs

```bash
curl http://localhost:3000/jobs
```

Returns an array of job objects.

---

#### Get a job

```bash
curl http://localhost:3000/jobs/<id>
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
  "log": [
    { "type": "text", "text": "Reading utils.py...", "ts": "2026-03-24T12:00:02.000Z" },
    { "type": "tool_call", "name": "Read", "input": { "file_path": "utils.py" }, "ts": "2026-03-24T12:00:03.000Z" },
    { "type": "text", "text": "Found an off-by-one error on line 42.", "ts": "2026-03-24T12:00:10.000Z" }
  ],
  "result": "success",
  "error": null,
  "sessionId": "sess_abc123",
  "images": []
}
```

---

#### Approve a plan

Once a job reaches `awaiting_approval`, review the `plan` field and approve it to proceed:

```bash
curl -X POST http://localhost:3000/jobs/<id>/approve
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "running" }
```

---

#### Reject a plan

```bash
curl -X POST http://localhost:3000/jobs/<id>/reject
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "failed" }
```

---

#### Send a follow-up

After a job `completed` (or `failed`), send an additional prompt continuing the same session:

```bash
curl -X POST http://localhost:3000/jobs/<id>/followup \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Also add type hints to all functions."}'
```

```json
{ "id": "20260324T120000000Z-abc-123", "status": "running" }
```

The follow-up accepts the same `images` field as job creation.

---

## Job Lifecycle

```
pending → planning → awaiting_approval → running → completed
                   ↕                   ↕        ↘ failed
             awaiting_user_question  awaiting_tool_approval
```

| Status | Description |
|--------|-------------|
| `pending` | Job accepted, not yet started |
| `planning` | Agent is drafting a plan (read-only) |
| `awaiting_approval` | Plan ready — waiting for human approval or rejection |
| `awaiting_tool_approval` | Agent wants to invoke a tool — waiting for human approval |
| `awaiting_user_question` | Agent asked a clarifying question — waiting for answers |
| `running` | Plan is being executed |
| `completed` | Job finished successfully |
| `failed` | Job failed or plan was rejected |

The two-phase model means the agent first produces a plan without making any changes, giving you a chance to review and approve before anything is modified. During execution, tool calls and clarifying questions can also be gated on human approval.

---

## Log Entry Types

Each entry in the `log` array has a `type` field:

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `text`, `ts` | Narrative output from the agent |
| `tool_call` | `name`, `input`, `ts` | A tool invocation with its inputs |
| `image` | `mediaType`, `url`, `ts` | An image produced by the agent |

---

## Images

Attach images to a job by base64-encoding them:

```bash
curl -X POST http://localhost:3000/jobs \
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

Saved images are served at `GET /images/:jobId/:filename`.

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `localhost` | Hostname to bind |
| `ANTHROPIC_API_KEY` | — | Required for the agent to run |

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to your branch and open a pull request

---

## License

MIT
