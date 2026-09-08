# Ink Paper Visualizer — Implementation Plan

Date: 2026-09-08 | Workspace: /Users/prayushkale/projects/ink-paper-visualizer (EMPTY — greenfield)

## Goal

A local web app where the user paints ink drops on virtual paper, folds the paper in 3D (Three.js) to create symmetric Rorschach-style blots, then sends the unfolded painting to a vision model (OpenRouter) that imagines what it could be, and finally generates a video from that interpretation (fal.ai, default `minimax/h3-max-turbo/image-to-video`) with the painting as the first frame — with an approval gate before the paid video step.

## Current context / assumptions

- Empty directory. No git repo yet. `requirements.txt` in the parent listing is unrelated.
- Decisions confirmed by user: **Vanilla TypeScript + Vite + Three.js** (no React), **small Node/Express proxy backend** (keys stay in server `.env`), **approval gate** between vision interpretation and video generation.
- API keys are NOT currently in env (`FAL_KEY`, `OPENROUTER_API_KEY` both unset here). User keeps FAL_KEY in `~/.zshrc`; the server loads `.env` in the project dir. Plan instructs creating `.env` — the user fills it.
- Verified FAL facts (from fal-video-model-guide skill):
  - `minimax/h3-max-turbo/image-to-video` schema: `prompt` (required), `image_url` (opening frame), `prompt_expansion_mode` ("fast"/"balanced"/"quality"), `resolution` ("480P"/"768P"), `duration` (int 5–15), `seed`. NO negative_prompt. Output 1344x768 @24fps, may carry a silent AAC track.
  - Queue API: `POST https://queue.fal.run/<endpoint>` with `Authorization: Key $FAL_KEY` → `{request_id, status_url, response_url, cancel_url}`; poll status_url until `status === "COMPLETED"`; GET response_url → `{video: {url}}`.
  - Data URIs work for images under ~5MB (a 1024px PNG blot is ~200-500KB — fine, no storage-upload path needed; noted as risk if user ups resolution).
  - Pricing (promo ended 2026-09-07): 480P $0.025/s, 768P $0.04/s.
- OpenRouter: standard OpenAI-compatible `POST /api/v1/chat/completions` with `messages[].content` array containing `{type:"text"}` + `{type:"image_url", image_url:{url: "<data URI>"}}`. Default vision model: `google/gemini-2.5-flash` (cheap, vision-capable); field is user-editable.

## Architecture

One repo, two processes started by one command: a Vite dev server serving the Three.js client, and an Express proxy (`server/index.mjs`, port 8787) that holds the API keys and forwards to OpenRouter and fal.ai. The ink painting's source of truth is an offscreen 2D canvas (1024x1024) used as a Three.js texture; folds are (a) animated in 3D by rotating half the paper mesh around the fold line, then (b) committed to the 2D canvas by a pure, unit-tested mirror-blit. The client walks a phase state machine: paint -> folding -> reveal -> interpreting -> review (gate) -> video -> done.

```
Browser (Vite :5173)                    Proxy (Express :8787)          External
+---------------------------+          +------------------------+     +-------------+
| Three.js scene            |  /api/*  | POST /api/interpret    | --> | OpenRouter  |
|  paper plane (2 halves)   | -------> | POST /api/video/submit | --> | fal.ai queue|
|  offscreen 1024px canvas  |  (vite   | GET  /api/video/status | --> |             |
|  texture = canvas         |  proxy)  | keys from server .env  |     +-------------+
| UI panels per phase       |          +------------------------+
+---------------------------+
```

File map (all new):

```
ink-paper-visualizer/
  package.json  tsconfig.json  vite.config.ts  index.html  .env  .env.example  .gitignore
  server/index.mjs            # Express proxy (complete code in Task 8/10)
  src/main.ts                 # bootstrap + phase state machine
  src/state.ts                # types + persisted settings
  src/ink/fold-math.ts        # PURE: fold geometry (mirroring) — unit-tested
  src/ink/paper.ts            # offscreen canvas: paintDrop, commitFold, exportPng
  src/three/scene.ts          # Three.js scene, half-mesh split, fold animation
  src/three/interact.ts       # raycast click -> UV -> paintDrop
  src/ui/panels.ts            # builds all DOM panels, one per phase
  src/api/client.ts           # fetch wrappers for the 3 proxy routes
  src/styles.css
  server/index.test.mjs  src/ink/fold-math.test.ts  src/ink/paper.test.ts
```

## Conventions for the implementer

- TDD where logic is pure (fold math, paper ops, server routes with mocked fetch). Three.js visuals and DOM panels are verified by exact manual checks listed per task.
- After every task: `npm test` green, then `git add -A && git commit -m "<message>"` (messages given per task). Never commit `.env`.
- TypeScript strict mode. No `any` except where casting DOM/WebGL glue.
- All UI copy in English. Financial/cost display in plain USD (this is per-generation pennies, not INR market data).

---

## Task 0 — Scaffold (verified greenfield)

Run:

```bash
cd /Users/prayushkale/projects/ink-paper-visualizer
git init
mkdir -p server src/ink src/three src/ui src/api
```

`package.json`:

```json
{
  "name": "ink-paper-visualizer",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k "npm:dev:client" "npm:dev:server"",
    "dev:client": "vite",
    "dev:server": "node --watch server/index.mjs",
    "test": "vitest run",
    "build": "vite build"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "three": "^0.168.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/three": "^0.168.0",
    "concurrently": "^9.0.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["vite/client"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Ink Paper Visualizer</title>
  <link rel="stylesheet" href="/src/styles.css" />
</head>
<body>
  <div id="app">
    <div id="stage"></div>
    <aside id="panel"></aside>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`src/styles.css` (starting point; panels.ts will rely on these classes):

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #1a1a1e; color: #e5e5ea; }
#app { display: flex; height: 100vh; }
#stage { flex: 1; position: relative; }
#panel { width: 340px; padding: 16px; overflow-y: auto; background: #232329; border-left: 1px solid #33333c; }
#panel h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; color: #9a9aa8; }
#panel label { display: block; margin: 10px 0 4px; font-size: 12px; color: #b0b0bc; }
#panel input[type="text"], #panel input[type="number"], #panel select, #panel textarea {
  width: 100%; padding: 6px 8px; background: #2c2c34; color: #e5e5ea; border: 1px solid #3d3d48; border-radius: 6px; font-size: 13px;
}
#panel textarea { min-height: 120px; resize: vertical; font-family: inherit; }
#panel input[type="range"] { width: 100%; }
#panel input[type="color"] { width: 100%; height: 36px; padding: 2px; background: #2c2c34; border: 1px solid #3d3d48; border-radius: 6px; }
#panel button {
  width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 8px; cursor: pointer;
  font-size: 14px; font-weight: 600; background: #4f46e5; color: white;
}
#panel button.secondary { background: #3d3d48; }
#panel button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 8px; } .row > * { flex: 1; }
.fold-item { display: flex; align-items: center; gap: 6px; margin: 4px 0; padding: 6px 8px; background: #2c2c34; border-radius: 6px; font-size: 13px; }
.fold-item button { width: auto; margin: 0; padding: 2px 8px; background: #55333c; }
.hint { font-size: 11px; color: #8888a0; margin-top: 4px; }
#panel video { width: 100%; margin-top: 12px; border-radius: 8px; background: #000; }
#panel img.thumb { width: 100%; border-radius: 8px; background: #fff; margin: 8px 0; }
```

`.gitignore`:

```
node_modules
dist
.env
```

`.env.example`:

```
OPENROUTER_API_KEY=sk-or-v1-...
FAL_KEY=...
PORT=8787
```

`.env`: copy of `.env.example` — tell the user to fill it in (FAL_KEY is in their `~/.zshrc`; OpenRouter key from openrouter.ai/keys).

Run `npm install`. Expected: completes with no errors (~30s).

Verify: `npx tsc --noEmit` prints nothing. Commit: `chore: scaffold vite + ts project`.

---

## Task 1 — Types and settings (src/state.ts)

`src/state.ts` (complete):

```ts
export type Phase =
  | 'paint'        // dropping ink, configuring folds
  | 'folding'      // fold animation running
  | 'reveal'       // blot shown, ready to interpret
  | 'interpreting' // vision call in flight
  | 'review'       // APPROVAL GATE: editable video prompt
  | 'video'        // video job submitted/polling
  | 'done';        // video ready

export type Axis = 'vertical' | 'horizontal';
/** which half folds over: left/right for vertical, top/bottom for horizontal */
export type Direction = 'left' | 'right' | 'top' | 'bottom';

export interface Fold {
  axis: Axis;
  direction: Direction;
}

export interface DropOptions {
  radius: number;   // px on the 1024px canvas, 10-120
  color: string;    // CSS color from <input type="color">
  wetness: number;  // 0-1, how far the blot splatters
}

/** Everything the user can configure for the video step. */
export interface VideoConfig {
  falModel: string;            // endpoint id, default 'minimax/h3-max-turbo/image-to-video'
  duration: number;            // int 5-15
  resolution: '480P' | '768P';
  promptExpansionMode: 'fast' | 'balanced' | 'quality';
  seed: number | null;         // null = random
  extraParamsJson: string;     // advanced: extra fields merged into FAL payload, '' = none
}

export interface Settings {
  openrouterModel: string;     // default 'google/gemini-2.5-flash'
  visionPrompt: string;        // default DEFAULT_VISION_PROMPT below
  video: VideoConfig;
}

export const DEFAULT_VISION_PROMPT = `You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colors and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams. Then write ONE vivid video-generation prompt for a short cinematic video that STARTS exactly from this painting as its first frame and then comes alive and evolves into what you imagined. Describe subject, motion, camera movement, lighting and mood. Output ONLY the video prompt text, under 150 words, no preamble.`;

export const DEFAULT_SETTINGS: Settings = {
  openrouterModel: 'google/gemini-2.5-flash',
  visionPrompt: DEFAULT_VISION_PROMPT,
  video: {
    falModel: 'minimax/h3-max-turbo/image-to-video',
    duration: 5,
    resolution: '768P',
    promptExpansionMode: 'fast',
    seed: null,
    extraParamsJson: '',
  },
};

/** Cost estimate in USD; rates verified 2026-09-08 (promo ended). */
export function estimateCost(cfg: VideoConfig): number {
  const perSec = cfg.resolution === '480P' ? 0.025 : 0.04;
  return cfg.duration * perSec;
}

const LS_KEY = 'ink-paper-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}
```

No test needed (trivial), but `estimateCost` gets one to enforce TDD habit — create `src/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_SETTINGS } from './state';

describe('estimateCost', () => {
  it('prices 768P at $0.04/s', () => {
    expect(estimateCost({ ...DEFAULT_SETTINGS.video, resolution: '768P', duration: 5 })).toBeCloseTo(0.2);
  });
  it('prices 480P at $0.025/s', () => {
    expect(estimateCost({ ...DEFAULT_SETTINGS.video, resolution: '480P', duration: 8 })).toBeCloseTo(0.2);
  });
});
```

Verify: `npm test` -> 2 passed. Commit: `feat: state types, settings persistence, cost estimate`.

---

## Task 2 — Fold math, TDD (src/ink/fold-math.ts)

The core of the Rorschach effect, as PURE functions on a normalized plane. All coordinates are UV space: x,y in [0,1], origin top-left.

`src/ink/fold-math.test.ts` (write FIRST, watch it fail):

```ts
import { describe, it, expect } from 'vitest';
import { mirrorPoint, mapPointThroughFolds, foldsToFullUnfold } from './fold-math';

describe('mirrorPoint', () => {
  it('folds left half onto right (vertical, fold left)', () => {
    expect(mirrorPoint({ x: 0.25, y: 0.7 }, { axis: 'vertical', direction: 'left' }))
      .toEqual({ x: 0.75, y: 0.7 });
  });
  it('folds top half onto bottom (horizontal, fold top)', () => {
    expect(mirrorPoint({ x: 0.4, y: 0.2 }, { axis: 'horizontal', direction: 'top' }))
      .toEqual({ x: 0.4, y: 0.8 });
  });
  it('folds bottom onto top', () => {
    expect(mirrorPoint({ x: 0.4, y: 0.9 }, { axis: 'horizontal', direction: 'bottom' }))
      .toEqual({ x: 0.4, y: 0.1 });
  });
  it('folds right onto left', () => {
    expect(mirrorPoint({ x: 0.8, y: 0.1 }, { axis: 'vertical', direction: 'right' }))
      .toEqual({ x: 0.2, y: 0.1 });
  });
  it('point on fold line is fixed', () => {
    expect(mirrorPoint({ x: 0.5, y: 0.3 }, { axis: 'vertical', direction: 'left' }))
      .toEqual({ x: 0.5, y: 0.3 });
  });
});

describe('mapPointThroughFolds', () => {
  it('sequence of 2 folds mirrors twice', () => {
    // vertical-fold-left then horizontal-fold-top == 180-degree point reflection
    const p = mapPointThroughFolds({ x: 0.2, y: 0.3 }, [
      { axis: 'vertical', direction: 'left' },
      { axis: 'horizontal', direction: 'top' },
    ]);
    expect(p).toEqual({ x: 0.8, y: 0.7 });
  });
  it('empty folds is identity', () => {
    expect(mapPointThroughFolds({ x: 0.3, y: 0.4 }, [])).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe('foldsToFullUnfold', () => {
  it('computes the fold stack implied by axis choices (quadrant folds)', () => {
    // one fold per axis chosen so far: vertical+horizontal => 4-way symmetry
    expect(foldsToFullUnfold([{ axis: 'vertical', direction: 'left' }])).toEqual([
      { axis: 'vertical', direction: 'left' },
    ]);
  });
});
```

Then implement `src/ink/fold-math.ts`:

```ts
import type { Fold } from '../state';

export interface UV { x: number; y: number; }

/**
 * Where does a point on the MOVING half land after this fold?
 * The moving half is the one `direction` names (left half for 'left', etc.);
 * it flips over the center line onto the stationary half.
 * Returns the mirrored position in the SAME (unfolded) coordinate frame.
 */
export function mirrorPoint(p: UV, fold: Fold): UV {
  if (fold.axis === 'vertical') {
    // direction 'left' = left half folds onto right => x -> 1 - x
    if (fold.direction === 'left') return { x: 1 - p.x, y: p.y };
    return { x: 1 - p.x, y: p.y };
  }
  // horizontal
  if (fold.direction === 'top') return { x: p.x, y: 1 - p.y };
  return { x: p.x, y: 1 - p.y };
}

/** Apply folds in order to a point (fold 1 happens first, its result feeds fold 2). */
export function mapPointThroughFolds(p: UV, folds: Fold[]): UV {
  return folds.reduce((acc, f) => mirrorPoint(acc, f), p);
}

/** Identity helper kept for symmetry with future refactors; folds list IS the unfold map. */
export function foldsToFullUnfold(folds: Fold[]): Fold[] {
  return folds;
}
```

Note: for both vertical directions the mirror is x -> 1-x, and for both horizontal directions y -> 1-y. Direction matters for the 3D animation (which half physically rotates) and for which half's pixels overwrite which, NOT for point mapping. The pixel-blit order in `commitFold` (Task 3) uses direction to decide source/target halves.

Verify: `npm test` -> fold-math tests pass (7 tests total). Commit: `feat: fold mirroring math with tests`.

---

## Task 3 — Paper canvas ops, TDD (src/ink/paper.ts)

The offscreen canvas is the single source of truth. `commitFold` blits one half onto the other through `drawImage` with scale(-1,1) mirroring — needs a real 2D context, so tests run in a JSDOM-free environment using a tiny stub: vitest's default node env has no canvas, so tests for pixel content use `@vitest/environment` happy-path: instead, test the GEOMETRY helpers (which half is source/target) purely, and verify actual blitting in the manual visual check of Task 5. Keep paper.ts pixel ops thin.

`src/ink/paper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { foldHalves, clampDropRadius } from './paper';

describe('foldHalves', () => {
  it('vertical fold-left: source = left half, target = right half', () => {
    const h = foldHalves({ axis: 'vertical', direction: 'left' });
    expect(h.sourceX).toBe(0);
    expect(h.targetX).toBe(0.5);
    expect(h.sourceY).toBe(0);
    expect(h.targetY).toBe(0);
  });
  it('vertical fold-right: source = right half, target = left', () => {
    const h = foldHalves({ axis: 'vertical', direction: 'right' });
    expect(h.sourceX).toBe(0.5);
    expect(h.targetX).toBe(0);
  });
  it('horizontal fold-top: source = top half, target = bottom', () => {
    const h = foldHalves({ axis: 'horizontal', direction: 'top' });
    expect(h.sourceY).toBe(0);
    expect(h.targetY).toBe(0.5);
    expect(h.sourceX).toBe(0);
    expect(h.targetX).toBe(0);
  });
});

describe('clampDropRadius', () => {
  it('clamps to [10, 120]', () => {
    expect(clampDropRadius(5)).toBe(10);
    expect(clampDropRadius(999)).toBe(120);
    expect(clampDropRadius(50)).toBe(50);
  });
});
```

`src/ink/paper.ts`:

```ts
import type { DropOptions, Fold } from '../state';

export const CANVAS_SIZE = 1024;

export interface Halves {
  sourceX: number; sourceY: number;  // top-left of source half (UV)
  targetX: number; targetY: number;  // top-left of target half (UV)
  width: number; height: number;     // half size (UV)
}

/** Which half moves (source) and which is printed onto (target). */
export function foldHalves(fold: Fold): Halves {
  if (fold.axis === 'vertical') {
    const src = fold.direction === 'left' ? 0 : 0.5;
    const tgt = fold.direction === 'left' ? 0.5 : 0;
    return { sourceX: src, sourceY: 0, targetX: tgt, targetY: 0, width: 0.5, height: 1 };
  }
  const src = fold.direction === 'top' ? 0 : 0.5;
  const tgt = fold.direction === 'top' ? 0.5 : 0;
  return { sourceX: 0, sourceY: src, targetX: 0, targetY: tgt, width: 1, height: 0.5 };
}

export function clampDropRadius(r: number): number {
  return Math.min(120, Math.max(10, r));
}

/** Paints with alpha-blend multiply so overlapping blots darken naturally. */
const INK_ALPHA = 0.92;

export class Paper {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.clear();
  }

  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#f4efe6';          // warm paper
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  /**
   * Drop ink at UV (0-1, origin top-left). Main blob + wetness-driven splatter:
   * a ring of small droplets whose spread scales with wetness.
   */
  paintDrop(u: number, v: number, opt: DropOptions): void {
    const x = u * CANVAS_SIZE;
    const y = v * CANVAS_SIZE;
    const r = clampDropRadius(opt.radius);
    this.ctx.globalAlpha = INK_ALPHA;
    this.ctx.fillStyle = opt.color;
    // main blob: irregular circle via overlapping circles
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.6 + Math.random() * 0.5);
      const rr = r * (0.25 + Math.random() * 0.4);
      this.ctx.beginPath();
      this.ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, Math.PI * 2);
      this.ctx.fill();
    }
    if (opt.wetness > 0) {
      const n = Math.floor(4 + opt.wetness * 24);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * (1.2 + Math.random() * (1 + opt.wetness * 2));
        const rr = 1 + Math.random() * r * 0.15;
        this.ctx.beginPath();
        this.ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    this.ctx.globalAlpha = 1;
  }

  /**
   * Physically commit a fold: blit the source half, mirrored, onto the target half,
   * then both halves hold identical ink — the crease line becomes a symmetry axis.
   */
  commitFold(fold: Fold): void {
    const h = foldHalves(fold);
    const S = CANVAS_SIZE;
    const sx = h.sourceX * S, sy = h.sourceY * S;
    const tx = h.targetX * S, ty = h.targetY * S;
    const w = h.width * S, hh = h.height * S;
    // temporary snapshot so target does not read partially-overwritten source
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = hh;
    snap.getContext('2d')!.drawImage(this.canvas, sx, sy, w, hh, 0, 0, w, hh);
    const sctx = snap.getContext('2d')!;
    if (fold.axis === 'vertical') {
      // mirror horizontally onto target
      this.ctx.save();
      this.ctx.translate(tx + w, ty);
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(snap, 0, 0);
      this.ctx.restore();
    } else {
      this.ctx.save();
      this.ctx.translate(tx, ty + hh);
      this.ctx.scale(1, -1);
      this.ctx.drawImage(snap, 0, 0);
      this.ctx.restore();
    }
    void sctx;
  }

  /** PNG data URI, white-bg, for OpenRouter vision + FAL image_url. */
  toDataUri(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Decoded blob size in bytes — UI shows it; must stay < 5MB for FAL. */
  async byteSize(): Promise<number> {
    const blob = await new Promise<Blob>((res) => this.canvas.toBlob(res, 'image/png')!);
    return blob.size;
  }
}
```

Verify: `npm test` -> all green (10 tests). Commit: `feat: paper canvas with fold blit + drop painting`.

---

## Task 4 — Three.js scene with fold animation (src/three/scene.ts)

Paper is TWO plane meshes (left/right or top/bottom split is done by generic half split: build four quadrant meshes so any fold axis can animate either pair). Simplest robust design: the paper is always 2 meshes (a "front" half and a "back" half is wrong for arbitrary folds) — instead build the paper as N segments along each axis? Overengineering. DECISION: the paper is ONE plane mesh; for the fold ANIMATION we overlay a temporary rotating half-plane (a clone textured with the current canvas) that rotates 180 degrees around the fold line, then we hide it and commit the fold to the canvas (Task 3). The base mesh's texture updates via `texture.needsUpdate = true` each frame during animation (the commit happens at animation end; during the animation the overlay shows the fold). This keeps geometry trivial and is visually convincing.

`src/three/scene.ts`:

```ts
import * as THREE from 'three';
import { Paper, CANVAS_SIZE } from '../ink/paper';
import type { Fold } from '../state';

export class InkScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private paperMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private texture: THREE.CanvasTexture;
  private foldMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private foldPivot: THREE.Group | null = null;
  private animating = false;

  constructor(private paper: Paper, container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 3);
    this.scene.background = new THREE.Color('#1a1a1e');
    this.texture = new THREE.CanvasTexture(paper.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture });
    this.paperMesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.paperMesh);
    window.addEventListener('resize', () => this.resize(container));
    this.resize(container);
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth, h = container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Flip the texture (canvas changed underneath). */
  refresh(): void {
    this.texture.needsUpdate = true;
  }

  /**
   * Animate fold over `ms` milliseconds, then commit to the canvas and clean up.
   * vertical fold line is the y-axis of the plane (x=0); horizontal is x-axis (y=0).
   */
  fold(fold: Fold, ms = 1200): Promise<void> {
    return new Promise((resolve) => {
      if (this.animating) return resolve();
      this.animating = true;
      const vertical = fold.axis === 'vertical';
      // overlay half matching the SOURCE half of the fold
      const w = vertical ? 1 : 2, h = vertical ? 2 : 1;
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, side: THREE.DoubleSide,
      });
      this.foldMesh = new THREE.Mesh(geo, mat);
      // center the overlay on the source half
      if (vertical) {
        this.foldMesh.position.x = fold.direction === 'left' ? -0.5 : 0.5;
      } else {
        this.foldMesh.position.y = fold.direction === 'top' ? 0.5 : -0.5;
      }
      this.foldPivot = new THREE.Group();
      this.scene.add(this.foldPivot);
      this.foldPivot.add(this.foldMesh);
      const start = performance.now();
      const dirSign = 1; // rotation direction purely cosmetic
      const tick = (): void => {
        const t = Math.min(1, (performance.now() - start) / ms);
        const eased = t * t * (3 - 2 * t); // smoothstep
        const angle = eased * Math.PI * dirSign;
        if (vertical) {
          // rotate around the vertical center line: pivot at x=0
          this.foldPivot.rotation.y = angle * (fold.direction === 'left' ? -1 : 1);
          this.foldMesh.position.x = (fold.direction === 'left' ? -0.5 : 0.5) * Math.cos(angle);
          this.foldMesh.position.z = Math.sin(angle) * 0.5;
        } else {
          this.foldPivot.rotation.x = angle * (fold.direction === 'top' ? 1 : -1);
          this.foldMesh.position.y = (fold.direction === 'top' ? 0.5 : -0.5) * Math.cos(angle);
          this.foldMesh.position.z = Math.sin(angle) * 0.5;
        }
        this.renderer.render(this.scene, this.camera);
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          this.scene.remove(this.foldPivot);
          this.foldMesh = null;
          this.foldPivot = null;
          this.animating = false;
          this.paper.commitFold(fold);   // authoritative pixel commit
          this.refresh();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** UV for a pointer event on the renderer canvas. Returns null if outside paper. */
  pointerToUV(ev: PointerEvent): { u: number; v: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = ray.intersectObject(this.paperMesh)[0];
    if (!hit) return null;
    return { u: hit.uv!.x, v: 1 - hit.uv!.y }; // canvas y is top-down
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

void CANVAS_SIZE;
```

No unit test (WebGL needs a real browser); manual verification is in Task 7.
Commit (after Task 5 wires it): `feat: three.js scene with fold animation`.

---

## Task 5 — Interaction + main loop (src/three/interact.ts, src/main.ts)

`src/three/interact.ts`:

```ts
import type { InkScene } from './scene';
import type { DropOptions } from '../state';
import type { Paper } from '../ink/paper';

/** Click/drag on the paper paints a drop at that spot. */
export function wirePainting(scene: InkScene, paper: Paper, getDrop: () => DropOptions): void {
  const paint = (ev: PointerEvent): void => {
    const uv = scene.pointerToUV(ev);
    if (!uv) return;
    paper.paintDrop(uv.u, uv.v, getDrop());
    scene.refresh();
  };
  const el = scene.renderer.domElement;
  el.addEventListener('pointerdown', paint);
  // drag paints a lighter, sparser trail (smaller radius)
  let dragging = false;
  el.addEventListener('pointerdown', () => { dragging = true; });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('pointerleave', () => { dragging = false; });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const uv = scene.pointerToUV(ev);
    if (!uv) return;
    paper.paintDrop(uv.u, uv.v, { ...getDrop(), radius: Math.max(10, getDrop().radius * 0.4) });
    scene.refresh();
  });
}
```

`src/main.ts` — the phase state machine; panels injected by Task 6. Skeleton for now (panels integrated in Task 6):

```ts
import { loadSettings, type Phase, type Settings, type Fold, type DropOptions } from './state';
import { Paper } from './ink/paper';
import { InkScene } from './three/scene';
import { wirePainting } from './three/interact';

const settings: Settings = loadSettings();
let phase: Phase = 'paint';
let folds: Fold[] = [];
let dropOptions: DropOptions = { radius: 40, color: '#1a1a2e', wetness: 0.5 };

const paper = new Paper();
const container = document.getElementById('stage')!;
const scene = new InkScene(paper, container);

wirePainting(scene, paper, () => dropOptions);

function renderLoop(): void {
  scene.render();
  requestAnimationFrame(renderLoop);
}
renderLoop();

// -- shared app object other modules read/write (panels register callbacks on it) --
export const app = {
  get phase(): Phase { return phase; },
  set phase(p: Phase) { phase = p; },
  get settings(): Settings { return settings; },
  folds,
  dropOptions,
  paper,
  scene,
  setDrop(d: DropOptions): void { dropOptions = d; },
  saveSettings(): void { saveSettingsMut(); },
};

import { saveSettings as saveSettingsMut } from './state';
```

Fix the import placement (move `saveSettings` import to top — implementer: keep imports tidy, the `app` export is a mutable singleton, that's fine for vanilla TS). Verify with `npx tsc --noEmit`: passes. Commit: `feat: main loop, pointer painting, app singleton`.

---

## Task 6 — UI panels per phase (src/ui/panels.ts)

DOM built with template literals; one panel per phase; CSS classes from Task 0. The panel is re-rendered by `renderPanel()` whenever phase or data changes. All controls bind immediately.

```ts
import { app } from '../main';
import { saveSettings, estimateCost, DEFAULT_VISION_PROMPT, type Fold, type Phase } from '../state';
import { api } from '../api/client';

const panelRoot = document.getElementById('panel')!;

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function renderPanel(): void {
  const p: Phase = app.phase;
  panelRoot.innerHTML = '';
  const settings = app.settings;
  if (p === 'paint') {
    panelRoot.appendChild(h(`
      <div>
        <h2>Ink & Paper</h2>
        <label>Ink color</label>
        <input type="color" id="inkColor" value="${app.dropOptions.color}" />
        <label>Drop size: <span id="dropSizeVal">${app.dropOptions.radius}</span> px</label>
        <input type="range" id="dropSize" min="10" max="120" value="${app.dropOptions.radius}" />
        <label>Wetness (splatter): <span id="wetVal">${app.dropOptions.wetness.toFixed(2)}</span></label>
        <input type="range" id="wetness" min="0" max="1" step="0.05" value="${app.dropOptions.wetness}" />
        <label>Click the paper to drop ink. Drag for a trail.</label>
        <hr style="border-color:#3d3d48; margin:14px 0" />
        <h2>Folds</h2>
        <div id="foldList"></div>
        <div class="row">
          <button class="secondary" id="addFoldV">+ Vertical fold</button>
          <button class="secondary" id="addFoldH">+ Horizontal fold</button>
        </div>
        <button id="btnFold">Fold paper</button>
        <button class="secondary" id="btnClear">Clear paper</button>
      </div>`));
    const upd = (): void => {
      app.dropOptions.color = (panelRoot.querySelector('#inkColor') as HTMLInputElement).value;
      app.dropOptions.radius = Number((panelRoot.querySelector('#dropSize') as HTMLInputElement).value);
      app.dropOptions.wetness = Number((panelRoot.querySelector('#wetness') as HTMLInputElement).value);
      (panelRoot.querySelector('#dropSizeVal') as HTMLElement).textContent = String(app.dropOptions.radius);
      (panelRoot.querySelector('#wetVal') as HTMLElement).textContent = app.dropOptions.wetness.toFixed(2);
    };
    panelRoot.querySelector('#inkColor')!.addEventListener('input', upd);
    panelRoot.querySelector('#dropSize')!.addEventListener('input', upd);
    panelRoot.querySelector('#wetness')!.addEventListener('input', upd);
    const renderFolds = (): void => {
      const list = panelRoot.querySelector('#foldList')!;
      list.innerHTML = app.folds.map((f, i) =>
        `<div class="fold-item">Fold ${i + 1}: ${f.axis} (${f.direction} half folds over)
          <button data-i="${i}" class="rm">x</button></div>`).join('');
      list.querySelectorAll<HTMLButtonElement>('.rm').forEach((b) =>
        b.addEventListener('click', () => { app.folds.splice(Number(b.dataset.i), 1); renderFolds(); }));
    };
    renderFolds();
    panelRoot.querySelector('#addFoldV')!.addEventListener('click', () => {
      app.folds.push({ axis: 'vertical', direction: app.folds.length % 2 === 0 ? 'left' : 'right' });
      renderFolds();
    });
    panelRoot.querySelector('#addFoldH')!.addEventListener('click', () => {
      app.folds.push({ axis: 'horizontal', direction: app.folds.length % 2 === 0 ? 'top' : 'bottom' });
      renderFolds();
    });
    panelRoot.querySelector('#btnFold')!.addEventListener('click', async () => {
      app.phase = 'folding';
      renderPanel();
      for (const f of [...app.folds]) {
        await app.scene.fold(f);
        app.folds.splice(app.folds.indexOf(f), 1);
      }
      app.phase = 'reveal';
      renderPanel();
    });
    panelRoot.querySelector('#btnClear')!.addEventListener('click', () => {
      app.paper.clear(); app.scene.refresh();
    });
  } else if (p === 'reveal') {
    panelRoot.appendChild(h(`
      <div>
        <h2>The Blot</h2>
        <img class="thumb" id="blotThumb" />
        <label>Vision model (OpenRouter)</label>
        <input type="text" id="orModel" value="${settings.openrouterModel}" />
        <label>Vision prompt (what the AI looks for)</label>
        <textarea id="visionPrompt">${settings.visionPrompt}</textarea>
        <button class="secondary" id="btnResetVision">Reset vision prompt</button>
        <button id="btnInterpret">Interpret with vision AI</button>
        <button class="secondary" id="btnMoreInk">Back to painting</button>
      </div>`));
    (panelRoot.querySelector('#blotThumb') as HTMLImageElement).src = app.paper.toDataUri();
    panelRoot.querySelector('#orModel')!.addEventListener('change', (e) => {
      settings.openrouterModel = (e.target as HTMLInputElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#visionPrompt')!.addEventListener('change', (e) => {
      settings.visionPrompt = (e.target as HTMLTextAreaElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#btnResetVision')!.addEventListener('click', () => {
      settings.visionPrompt = DEFAULT_VISION_PROMPT; saveSettings(settings); renderPanel();
    });
    panelRoot.querySelector('#btnMoreInk')!.addEventListener('click', () => { app.phase = 'paint'; renderPanel(); });
    panelRoot.querySelector('#btnInterpret')!.addEventListener('click', async () => {
      app.phase = 'interpreting'; renderPanel();
      const thumb = panelRoot.querySelector('#blotThumb') as HTMLImageElement;
      const interpretation = await api.interpret(app.paper.toDataUri(), settings.openrouterModel, settings.visionPrompt);
      window.lastInterpretation = interpretation; // see note
      app.phase = 'review'; renderPanel();
      void thumb;
    });
  } else if (p === 'interpreting' || p === 'video') {
    panelRoot.appendChild(h(`<div><h2>${p === 'interpreting' ? 'Vision AI is imagining...' : 'Generating video...'}</h2>
      <div class="hint">This can take 10-60 seconds.</div></div>`));
  } else if (p === 'review') {
    // APPROVAL GATE: editable video prompt + full video config + cost estimate
    const v = settings.video;
    panelRoot.appendChild(h(`
      <div>
        <h2>AI Interpretation - APPROVE BEFORE GENERATING</h2>
        <img class="thumb" id="blotThumb2" />
        <label>Video prompt (edit freely before generating)</label>
        <textarea id="videoPrompt">${window.lastInterpretation ?? ''}</textarea>
        <div class="row">
          <button class="secondary" id="btnReInterpret">Re-interpret</button>
          <button class="secondary" id="btnInterpretEdit">Interpret edited blot (manual)</button>
        </div>
        <hr style="border-color:#3d3d48; margin:14px 0" />
        <h2>Video settings (fal.ai)</h2>
        <label>FAL model endpoint</label>
        <input type="text" id="falModel" value="${v.falModel}" />
        <label>Duration: <span id="durVal">${v.duration}</span> s (5-15)</label>
        <input type="range" id="duration" min="5" max="15" step="1" value="${v.duration}" />
        <label>Resolution</label>
        <select id="resolution">
          <option value="480P" ${v.resolution === '480P' ? 'selected' : ''}>480P ($0.025/s)</option>
          <option value="768P" ${v.resolution === '768P' ? 'selected' : ''}>768P ($0.04/s)</option>
        </select>
        <label>Prompt expansion mode</label>
        <select id="pem">
          <option value="fast" ${v.promptExpansionMode === 'fast' ? 'selected' : ''}>fast (keeps your wording)</option>
          <option value="balanced" ${v.promptExpansionMode === 'balanced' ? 'selected' : ''}>balanced</option>
          <option value="quality" ${v.promptExpansionMode === 'quality' ? 'selected' : ''}>quality (richer rewrite)</option>
        </select>
        <label>Seed (blank = random)</label>
        <input type="text" id="seed" value="${v.seed ?? ''}" />
        <label>Extra params JSON (advanced, merged into FAL payload)</label>
        <textarea id="extraJson" style="min-height:60px">${v.extraParamsJson}</textarea>
        <div class="hint">Estimated cost: $<span id="cost">${estimateCost(v).toFixed(3)}</span></div>
        <button id="btnGenerate">Generate video</button>
        <button class="secondary" id="btnBackPaint">Start over (new painting)</button>
      </div>`));
    (panelRoot.querySelector('#blotThumb2') as HTMLImageElement).src = app.paper.toDataUri();
    const syncCost = (): void => {
      (panelRoot.querySelector('#cost') as HTMLElement).textContent = estimateCost(v).toFixed(3);
    };
    const bind = <T extends HTMLInputElement>(sel: string, fn: (el: T) => void, ev = 'change'): void => {
      panelRoot.querySelector(sel)!.addEventListener(ev, (e) => { fn(e.target as T); saveSettings(settings); });
    };
    bind('#duration', (el) => { v.duration = Number(el.value); (panelRoot.querySelector('#durVal') as HTMLElement).textContent = el.value; syncCost(); }, 'input');
    bind('#resolution', (el) => { v.resolution = el.value as '480P' | '768P'; syncCost(); });
    bind('#pem', (el) => { v.promptExpansionMode = el.value as 'fast' | 'balanced' | 'quality'; });
    bind('#seed', (el) => { v.seed = el.value === '' ? null : Number(el.value); });
    bind('#extraJson', (el) => { v.extraParamsJson = el.value; });
    panelRoot.querySelector('#falModel')!.addEventListener('change', (e) => {
      v.falModel = (e.target as HTMLInputElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#btnGenerate')!.addEventListener('click', async () => {
      // validate extra JSON before spending money
      if (v.extraParamsJson.trim() !== '') {
        try { JSON.parse(v.extraParamsJson); } catch {
          alert('Extra params JSON is invalid - fix it before generating.'); return;
        }
      }
      app.phase = 'video'; renderPanel();
      const prompt = (panelRoot.querySelector('#videoPrompt') as HTMLTextAreaElement).value;
      await submitVideo(prompt);
    });
    panelRoot.querySelector('#btnReInterpret')!.addEventListener('click', () => { app.phase = 'reveal'; renderPanel(); });
    panelRoot.querySelector('#btnBackPaint')!.addEventListener('click', () => { resetAll(); });
  } else if (p === 'done') {
    panelRoot.appendChild(h(`
      <div>
        <h2>Your Video</h2>
        <video id="resultVideo" controls autoplay loop></video>
        <a id="downloadLink" class="hint" download="ink-video.mp4">Download mp4</a>
        <button class="secondary" id="btnNewPainting">New painting</button>
      </div>`));
    const vid = panelRoot.querySelector('#resultVideo') as HTMLVideoElement;
    vid.src = window.lastVideoUrl!;
    (panelRoot.querySelector('#downloadLink') as HTMLAnchorElement).href = window.lastVideoUrl!;
    panelRoot.querySelector('#btnNewPainting')!.addEventListener('click', () => resetAll());
  }
}

async function submitVideo(prompt: string): Promise<void> {
  const v = app.settings.video;
  const { request_id } = await api.submitVideo({
    image: app.paper.toDataUri(),
    prompt,
    config: v,
  });
  // poll
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await api.videoStatus(request_id);
    if (st.status === 'COMPLETED') {
      window.lastVideoUrl = st.videoUrl;
      app.phase = 'done'; renderPanel();
      return;
    }
    if (st.status === 'FAILED' || st.status === 'ERROR') {
      alert('Video generation failed: ' + (st.error ?? 'unknown'));
      app.phase = 'review'; renderPanel();
      return;
    }
  }
}

function resetAll(): void {
  app.paper.clear();
  app.scene.refresh();
  app.folds.length = 0;
  window.lastVideoUrl = undefined;
  window.lastInterpretation = undefined;
  app.phase = 'paint';
  renderPanel();
}

// global staging (declare in a global.d.ts in the implementer's pass)
declare global {
  interface Window {
    lastInterpretation?: string;
    lastVideoUrl?: string;
  }
}
void api;
```

Manual verification (no browser test harness — exact checks):
1. `npm run dev` -> open http://localhost:5173
2. Paint panel: move size slider -> "Drop size" number updates; click paper -> dark blob appears; drag -> trail
3. Add "Vertical fold" -> list shows "Fold 1: vertical (left half folds over)"; press x -> removed
4. Press "Fold paper" -> overlay half rotates over ~1.2s, blot becomes symmetric, panel switches to The Blot
5. Reveal panel shows the blot thumbnail; edit model/prompt fields; type junk in vision model -> persists after reload

Commit: `feat: phase panels with paint, fold, reveal, review, done`.

---

## Task 7 — API client (src/api/client.ts)

```ts
import type { VideoConfig } from '../state';

export interface SubmitResponse { request_id: string; }
export interface StatusResponse { status: string; videoUrl?: string; error?: string; }

export const api = {
  async interpret(imageDataUri: string, model: string, visionPrompt: string): Promise<string> {
    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUri, model, visionPrompt }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'interpret failed');
    const data = (await res.json()) as { text: string };
    return data.text;
  },
  async submitVideo(body: { image: string; prompt: string; config: VideoConfig }): Promise<SubmitResponse> {
    const res = await fetch('/api/video/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'submit failed');
    return (await res.json()) as SubmitResponse;
  },
  async videoStatus(requestId: string): Promise<StatusResponse> {
    const res = await fetch(`/api/video/status?request_id=${encodeURIComponent(requestId)}`);
    if (!res.ok) throw new Error('status failed');
    return (await res.json()) as StatusResponse;
  },
};
```

Verify: `npx tsc --noEmit` passes. Commit: `feat: typed api client`.

---

## Task 8 — Proxy server (server/index.mjs), TDD with mocked fetch

`server/index.test.mjs` (write FIRST). Uses node:test + a stubbed global fetch; no supertest dependency — call the route handlers via the exported `app.handle(req,res)` (Express apps are callable). Keep it simple: build the server with injected fetcher for testability.

First refactor the server to export a factory: `createServer({ fetchImpl })`. Test:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './index.mjs';

const jsonRes = (body, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => body,
});

test('POST /api/interpret forwards to openrouter with image content parts', async () => {
  const calls = [];
  const app = createServer({
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return jsonRes({ choices: [{ message: { content: 'A phoenix rising.' } }] });
    },
  });
  const res = await inject(app, 'POST', '/api/interpret', {
    image: 'data:image/png;base64,AAA', model: 'm1', visionPrompt: 'vp',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'A phoenix rising.');
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  assert.equal(calls[0].body.model, 'm1');
  assert.deepEqual(calls[0].body.messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
});

test('POST /api/video/submit forwards to fal queue with merged extra params', async () => {
  const calls = [];
  const app = createServer({
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return jsonRes({ request_id: 'rq_1', status_url: 's', response_url: 'r', cancel_url: 'c' });
    },
  });
  const res = await inject(app, 'POST', '/api/video/submit', {
    image: 'data:image/png;base64,AAA',
    prompt: 'p',
    config: { falModel: 'minimax/h3-max-turbo/image-to-video', duration: 5, resolution: '768P', promptExpansionMode: 'fast', seed: 7, extraParamsJson: '{\"subject_motion\":\"fast\"}' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.request_id, 'rq_1');
  const falCall = calls[0];
  assert.ok(falCall.url === 'https://queue.fal.run/minimax/h3-max-turbo/image-to-video');
  assert.equal(falCall.body.image_url, 'data:image/png;base64,AAA');
  assert.equal(falCall.body.duration, 5);
  assert.equal(falCall.body.seed, 7);
  assert.equal(falCall.body.subject_motion, 'fast'); // extra params merged at top level
  assert.ok(!('extraParamsJson' in falCall.body));
});

test('submit rejects invalid extraParamsJson with 400', async () => {
  const app = createServer({ fetchImpl: async () => { throw new Error('should not call'); } });
  const res = await inject(app, 'POST', '/api/video/submit', {
    image: 'i', prompt: 'p',
    config: { falModel: 'm', duration: 5, resolution: '480P', promptExpansionMode: 'fast', seed: null, extraParamsJson: 'not json' },
  });
  assert.equal(res.status, 400);
});

test('GET /api/video/status maps fal status payload', async () => {
  const calls = [];
  const app = createServer({
    fetchImpl: async (url) => { calls.push(url); return jsonRes({ status: 'COMPLETED', response_url: 'https://f/r' }); },
  });
  // stub second fetch for response_url
  let n = 0;
  const app2 = createServer({
    fetchImpl: async (url) => {
      n++;
      if (n === 1) return jsonRes({ status: 'COMPLETED', response_url: 'https://f/r' });
      return jsonRes({ video: { url: 'https://cdn/v.mp4' } });
    },
  });
  void app;
  const res = await inject(app2, 'GET', '/api/video/status?request_id=rq1&status_url=' + encodeURIComponent('https://queue.fal.run/x/rq1/status') + '&response_url=' + encodeURIComponent('https://f/r'), {});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'COMPLETED');
  assert.equal(res.body.videoUrl, 'https://cdn/v.mp4');
});

// tiny helper: invoke express app without starting a listener
async function inject(app, method, path, body) {
  const req = new Request('http://x' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  // Express can't take a WHATWG Request directly; simplest robust inject is via fetch to a listening server:
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  server.close();
  return { status: res.status, body: json };
}
```

Add `"test:server": "node --test server/"` script; fold into `test` script: `"test": "vitest run && node --test server/"`.

`server/index.mjs` (complete):

```js
import 'dotenv/config';
import express from 'express';

export function createServer({ fetchImpl = fetch } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const FAL_KEY = process.env.FAL_KEY;
  const queueBase = 'https://queue.fal.run';

  // Health: tells the UI whether keys are present (never returns the keys)
  app.get('/api/health', (_req, res) => {
    res.json({ openrouter: !!OPENROUTER_KEY, fal: !!FAL_KEY });
  });

  // Vision interpretation via OpenRouter (OpenAI-compatible multimodal)
  app.post('/api/interpret', async (req, res) => {
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY missing in server .env' });
    const { image, model, visionPrompt } = req.body ?? {};
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'image must be a data URI' });
    }
    try {
      const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || 'google/gemini-2.5-flash',
          messages: [
            { role: 'user', content: [
              { type: 'text', text: visionPrompt },
              { type: 'image_url', image_url: { url: image } },
            ] },
          ],
        }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.error?.message ?? 'openrouter error' });
      return res.json({ text: data.choices?.[0]?.message?.content ?? '' });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // Submit video job to fal queue
  app.post('/api/video/submit', async (req, res) => {
    if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY missing in server .env' });
    const { image, prompt, config } = req.body ?? {};
    if (typeof prompt !== 'string' || prompt.length < 5) return res.status(400).json({ error: 'prompt required' });
    let extra = {};
    if (config?.extraParamsJson && String(config.extraParamsJson).trim() !== '') {
      try { extra = JSON.parse(config.extraParamsJson); } catch {
        return res.status(400).json({ error: 'extraParamsJson is not valid JSON' });
      }
    }
    const payload = {
      prompt,
      image_url: image,
      duration: config?.duration ?? 5,
      resolution: config?.resolution ?? '768P',
      prompt_expansion_mode: config?.promptExpansionMode ?? 'fast',
      ...(config?.seed != null ? { seed: config.seed } : {}),
      ...extra, // extra params can override defaults intentionally
    };
    try {
      const r = await fetchImpl(`${queueBase}/${config?.falModel ?? 'minimax/h3-max-turbo/image-to-video'}`, {
        method: 'POST',
        headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.detail ?? JSON.stringify(data) });
      return res.json({ request_id: data.request_id, status_url: data.status_url, response_url: data.response_url });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // Poll fal queue status; when COMPLETED, fetch the result for the video URL
  app.get('/api/video/status', async (req, res) => {
    if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY missing in server .env' });
    const { status_url, response_url } = req.query;
    if (typeof status_url !== 'string') return res.status(400).json({ error: 'status_url required' });
    try {
      const r = await fetchImpl(status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'fal status error' });
      if (data.status === 'COMPLETED' && typeof response_url === 'string') {
        const r2 = await fetchImpl(response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
        const result = await r2.json();
        return res.json({ status: 'COMPLETED', videoUrl: result.video?.url ?? null });
      }
      return res.json({ status: data.status, queue: data.queue_position, error: data.error });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  return app;
}

if (process.env.VITEST === undefined && process.argv[1]?.endsWith('index.mjs')) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => console.log(`proxy on :${port}`));
}
```

IMPORTANT correction to the client (Task 7 + panels): `submitVideo` must RETURN `status_url` and `response_url` too, and the poller passes them to `videoStatus`. Update `SubmitResponse` to `{ request_id: string; status_url: string; response_url: string }` and `videoStatus(requestId, statusUrl, responseUrl)` -> GET `/api/video/status?status_url=...&response_url=...`. The implementer applies this when wiring Task 6 (this note supersedes the earlier signature).

Verify: `npm run test:server` -> 4 tests pass. Then `npm test` -> all green. Commit: `feat: express proxy for openrouter + fal with tests`.

NOTE on test isolation: `node --watch server/index.mjs` starts a listener when run directly; guard is `process.argv[1].endsWith('index.mjs')` — under `node --test server/`, argv[1] is the test file, so no port clash.

---

## Task 9 — Wire panels into main (src/main.ts final)

Replace Task 5 skeleton tail with:

```ts
import { renderPanel } from './ui/panels';
renderPanel();

// health banner if keys missing
fetch('/api/health').then((r) => r.json()).then((h: { openrouter: boolean; fal: boolean }) => {
  if (!h.openrouter || !h.fal) {
    const b = document.createElement('div');
    b.className = 'hint';
    b.style.cssText = 'padding:10px;background:#55333c;border-radius:8px;margin:10px';
    b.textContent = !h.openrouter && !h.fal
      ? 'Server .env missing OPENROUTER_API_KEY and FAL_KEY - set them and restart npm run dev.'
      : `Server .env missing ${!h.openrouter ? 'OPENROUTER_API_KEY' : 'FAL_KEY'} - set it and restart.`;
    document.getElementById('panel')!.prepend(b);
  }
});
```

Also move `saveSettings` import to the top of main.ts and clean the trailing import noted in Task 5. Add `src/global.d.ts`:

```ts
export {};
declare global {
  interface Window { lastInterpretation?: string; lastVideoUrl?: string; }
}
```

Verify: `npx tsc --noEmit` -> clean. Commit: `feat: wire panels + key health banner`.

---

## Task 10 — End-to-end smoke test (user-run, real keys)

1. User fills `.env` (FAL_KEY from ~/.zshrc, OpenRouter key from openrouter.ai/keys), restarts `npm run dev`.
2. Paint a blot, one vertical fold, fold it, "Interpret with vision AI" -> editable prompt appears (~5-15s).
3. Review panel: set duration 5, resolution 480P (~$0.13) -> "Generate video" -> ~20-40s -> video plays in the panel; Download link works.
4. Expected result: video's first frame is the blot; it evolves per the approved prompt.

If the video fails: check server console for the fal error detail; `cancel_url` is returned on submit but unused (v1 keeps it simple; a Cancel button is a listed improvement).

---

## Improvement suggestions (not in v1 — discuss before building)

1. **FAL storage upload for large images** — if you raise canvas to 2048px the data URI may approach the 5MB limit; add the storage upload path (initiate -> PUT -> file_url).
2. **Cancel button** during video generation using `cancel_url` (already returned).
3. **History gallery** — localStorage blobs of blot PNG + generated prompt + video URL per session.
4. **Blot animation on video end** — currently the video just plays; could crossfade back to the blot.
5. **Ink texture realism** — replace flat circles with a paper-fiber displacement shader (Three.js ShaderMaterial) so ink bleeds; also rough paper normal map.
6. **Multiple drops per fold step** — paint several drops, then fold, then paint MORE onto the folded paper, then unfold everything (real Rorschach workflow: ink inside the fold). Currently we only mirror after the fold; painting on a folded state requires mapping clicks through the fold stack — `mapPointThroughFolds` already supports it (fold-math.ts), so v2: allow painting while "folded" and auto-mirror.
7. **Vision model chaining** — ask 2 cheap models to interpret, show both, pick one (or merge).
8. **Seed pinning + "variations"** — same blot+prompt, different seeds, 4 videos in a grid.
9. **Fold diagonals** — allow arbitrary fold lines (diagonal folds create wilder 8-way symmetry); needs generalized mirror around an arbitrary line, not just center axes.
10. **Sound design** — mute by default, but paper-fold rustle + ink-drop plip via WebAudio adds a lot.

## Risks / open questions

- **FAL data URI size**: 1024px PNG blot is well under 5MB; if you paint with heavy wetness the PNG stays flat-colored, so fine. Risk only at higher canvas sizes (see improvement 1).
- **FAL model schema drift**: this plan bakes in the h3-max-turbo schema; if the default endpoint changes, `extraParamsJson` covers new fields but renamed core fields (e.g. `image_url` -> `image`) would need a code edit. The model endpoint is user-configurable, so schema is the user's responsibility to match — surfaced in the UI copy.
- **OpenRouter free-tier models** can reject data-URI images; the default (gemini-2.5-flash) is vision-capable and paid. If the user picks a text-only model, OpenRouter returns an error which the UI surfaces raw.
- **Silent AAC track** in h3 output: harmless for in-browser playback.
- **Open question**: should the vision prompt be allowed to output structured JSON (e.g. subject + camera + mood separately) for finer editing? v1 keeps free text — the review panel textarea is the editing surface.
- **Open question**: animation of ink DURING fold (paper absorbs ink while folded) — v1 commits pixels only at the end of the animation. The visual is a mirror-then-unfold; acceptable for v1.

## Definition of done

- All tests green (`npm test` covers vitest + node --test).
- `npx tsc --noEmit` clean.
- Manual checks in Task 6 pass.
- One real end-to-end generation with real keys (Task 10) produces a playable video.
