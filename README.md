# AEGIS

AEGIS is a TypeScript/Express autonomous-operations control center. It turns a validated objective into a dependency-aware workflow, executes deterministic specialist handlers, records outcomes, and exposes safety, diagnosis, workflow revision, and bounded recovery decisions.

## Implemented capabilities

- Structured workflow planning through Groq's OpenAI-compatible API.
- Zod validation for workflow plans, node types, validation contracts, dependencies, and cycles.
- Deterministic dependency-aware orchestration with independent-branch continuation.
- Typed specialist dispatch with a deterministic Validator Agent and side-effect-free placeholders for other agent types.
- Independent fail-closed Safety Gate for allowlisted, unknown, malformed, and destructive actions.
- Deterministic Workflow Diagnostician with structured categories and retryability.
- Proposal-only Workflow Architect with validated workflow revisions and typed workflow diffs.
- Bounded recovery controller with a maximum of two recovery attempts after the initial attempt.
- In-memory and SQLite-backed execution and recovery persistence.
- React + Vite + TypeScript dashboard with React Flow workflow visualization.

This project does not currently perform real browser automation, arbitrary shell/code execution, irreversible external writes, or automatic deployment.

## Requirements

- Node.js 24 or newer (the backend uses `node:sqlite`).
- A Groq API key and accessible Groq model only when using the planning endpoint.

## Backend setup

From the project root:

```powershell
npm install
Copy-Item .env.example .env
```

Set the values in `.env` locally. Never commit `.env` or API keys.

Available backend variables:

```env
PORT=3000
FRONTEND_ORIGIN=https://aegis-askwd17jq-mojesh1.vercel.app
GROQ_API_KEY=replace-with-your-groq-api-key
GROQ_MODEL=replace-with-a-groq-model-id-you-have-access-to
SQLITE_PATH=data/aegis.sqlite
```

`FRONTEND_ORIGIN` is an exact comma-separated allowlist for browser origins. If it is missing, same-origin requests still work but cross-origin browser requests are denied safely; it never falls back to `*`. Set it in the Render service environment to the deployed Vercel origin.

Run the backend in development:

```powershell
npm run dev
```

Build and run the backend:

```powershell
npm run build
npm run start
```

Backend URLs:

- `GET /health`
- `POST /api/plan`
- `POST /api/execute`
- `POST /api/executions`
- `GET /api/executions/:id`
- `POST /api/recoveries`
- `GET /api/recoveries/:id`

## Frontend setup

From the frontend directory:

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

The Vite development proxy sends `/api` and `/health` requests to `http://localhost:3000`. `VITE_API_BASE_URL` can be set for a direct backend origin when the deployment supplies the appropriate cross-origin configuration.

Frontend checks:

```powershell
npm run typecheck
npm run build
```

## Verification

Backend:

```powershell
npm test
npm run typecheck
npm run build
```

Frontend:

```powershell
cd frontend
npm run typecheck
npm run build
```
