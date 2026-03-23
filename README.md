# agents-orchestrator

HTTP API for submitting and tracking AI agent jobs powered by Claude.

## Setup

```bash
bun install
bun run dev
```

## Usage

**Submit a job:**

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Review utils.py for bugs and fix any issues you find."}'
```

```json
{ "id": "abc-123", "status": "pending" }
```

**Check status:**

```bash
curl http://localhost:3000/jobs/abc-123
```

```json
{
  "id": "abc-123",
  "status": "completed",
  "prompt": "...",
  "tools": ["Read", "Edit", "Glob"],
  "createdAt": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "log": [
    { "type": "text", "text": "Looking at utils.py...", "ts": "..." },
    { "type": "tool_call", "name": "Read", "ts": "..." }
  ],
  "result": "success",
  "error": null
}
```

**Custom tools:**

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Search for TODO comments.", "tools": ["Glob", "Grep"]}'
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | — | Required for the agent to run |
