# Ink & Paper Visualizer

A Three.js web app that visualizes ink-folding on paper. A React-free
TypeScript/Vite client renders a Three.js scene; a small Express proxy keeps
API keys server-side and forwards vision (OpenRouter) and video (fal.ai queue)
requests.

## Setup

```bash
npm install

# configure keys (server-side only, never shipped to the client)
cp .env.example .env
# then edit .env and fill in:
#   OPENROUTER_API_KEY  - OpenRouter key (vision endpoint)
#   FAL_KEY             - fal.ai key (image-to-video queue)
#   PORT                - optional, proxy port (default 8787)

# run client + proxy together
npm run dev
```

Open the Vite URL (default http://localhost:5173). The client talks to the
proxy on http://localhost:8787.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Express proxy (concurrently) |
| `npm run dev:client` | Vite dev server only |
| `npm run dev:server` | Express proxy only (node --watch) |
| `npm run test` | Client tests (vitest) + server tests (node --test) |
| `npm run test:client` | Client tests only |
| `npm run test:server` | Server tests only |
| `npm run build` | Production build to `dist/` |

## Tests

- Client: `src/*.test.ts`, `src/ink/*.test.ts` via vitest
- Server: `server/index.test.mjs` via `node --test`

## Stack

- TypeScript + Vite (client, no framework)
- Three.js scene in `src/three/`
- Fold math in `src/ink/fold-math.ts`, paper canvas in `src/ink/paper.ts`
- Express proxy in `server/index.mjs` (OpenRouter vision + fal.ai queue)
