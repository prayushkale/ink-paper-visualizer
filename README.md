# Ink & Film

A live studio for **MiniMax H3 Max Director** on fal.ai.

Real ink blots are painted by a physical simulation, imagined by a vision model,
and then realised as **one continuous, unbroken film** that the model streams at
24 fps with native audio. The blots keep coming, so the film never restarts: each
new blot is a destination the picture has to arrive at, and between arrivals the
stream is free to become whatever the mood and the score suggest.

Two things make it more than a pretty demo:

* **The film is a chain, not a clip.** A Director session is not resumable, so a
  long film is several sessions opened on one another. Every new session starts
  on the previous one's exact final frame, so the seam is invisible.
* **The camera is real.** Alongside Director, the app drives
  `minimax/h3-max/multi-angle/image-to-video` to orbit a blot into a set of
  consistent viewpoints, then hands those *stills* to the stream as destinations.
  The result reads as one object explored in 3D rather than a slideshow.

---

## Quick start

```bash
npm install --include=dev      # see "dev dependencies" below
cp .env.example .env           # then fill in FAL_KEY and OPENROUTER_API_KEY
npm run dev                    # client on :5173, proxy on :8787
```

Open <http://localhost:5173>.

To try it without spending anything, tick **Dry run** under **Budget**. The whole
pipeline runs against a fake transport.

### What you need

| Variable | Why |
|---|---|
| `FAL_KEY` | The Director session, the Multi Angle orbits, and hosting your blot and music files. |
| `OPENROUTER_API_KEY` | The vision model that decides what each blot could be. |

Optional: `PROXY_AUTH_TOKEN` makes the browser echo a token on every proxied
call (set `HOST=0.0.0.0` only if you know why — the proxy holds your fal key and
binds to loopback by default).

`.env` is the single source of truth for these keys. The server loads it with
`override: true`, so a stale `export FAL_KEY=...` in `~/.zshrc` or `~/.bashrc`
cannot shadow what you put in the file. If you see `credential has been revoked`
from fal, the key itself was revoked in the fal dashboard — generate a new one.

---

## Cost, honestly

Director bills **per second of generated video**, not per request.

| | Launch rate (to 2026-09-14) | List rate |
|---|---|---|
| Director | **$0.02 / s** | $0.08 / s |
| Multi Angle 480p | $0.0125 / s | $0.05 / s |
| Multi Angle 768p | $0.02 / s | $0.08 / s |
| Multi Angle 1080p (upscaled from 768p) | $0.04 / s | $0.16 / s |

Every session also bills a **60 second minimum**, so a session you cut short
after fifteen seconds still costs a minute. A 15-minute session is $18 at the
launch rate.

Two consequences the app is built around:

1. **A film left alone will spend until your balance is gone.** The session and
   daily caps under **Budget** are enforced by a guard that stops the stream
   itself, not by a warning you might miss.
2. **Chaining has a floor.** Two 60 second sessions cost more than one 120 second
   session, because each one bills its own minimum. The pre-flight estimate in
   the UI already accounts for this.

Multi Angle spends on its own meter. Orbit takes are skipped (with a warning)
rather than silently blowing the cap.

---

## How a run works

```
seeded ink engine ──► blot ──► hosted on fal ──► vision model ──► a beat
                                   │                                 │
                                   └──► Multi Angle orbits ──► arrival stills
                                                                     │
                                                                     ▼
             Director session ◄── one destination per dispatched chunk
                    │
                    ├─ chunk telemetry ──► buffer health, cost meter
                    └─ session ceiling ──► handover ──► new session, same picture
```

1. **Ink.** A seed picks tools (drop, splatter, streak, curve, pool, drag, spray,
   backrun), a palette, and a fold plan of 0–3 vertical/horizontal creases at a
   centre or off-centre position. The canvas is rendered at the stream's aspect
   ratio, because image-to-video inherits the ratio of the image you give it.
2. **Imagining.** The vision model is handed the blot plus the running context —
   mood, score, camera move, and the last several beats — and answers with
   structured JSON. A model that answers in prose still produces a usable beat,
   because a live film cannot stop to fix a parse.
3. **Orbits.** Multi Angle turns the blot into keyframed camera takes; the app
   extracts each clip's **final pose** (the model holds it to the end) and hosts
   it. Those stills are consistent views of the same frozen scene.
4. **The film.** The scheduler sends one direction per *dispatched* chunk,
   carrying the next arrival image and the text that describes it. A blot with two
   angles occupies three chunks: the blot, then two views of it.
5. **Handover.** Just before the server's own ceiling the session is retired and
   a new one opens on the last frame (or on another angle, if you chose *turn*).
   The recording keeps running across the seam, so the export is one file.

### Why one direction per dispatched chunk

A direction applies to the next *undispatched* chunk. Generators run faster than
playback, so a burst of directions would collapse into the last one and blots
would silently vanish. The scheduler therefore opens its gate only when a chunk
arrives carrying the `prompt_version` it last sent, with a watchdog that reopens
the gate if an acknowledgement never comes.

---

## What you can control

| Group | Controls |
|---|---|
| **Stream** | resolution, frame (16:9 / 9:16 / 1:1), memory (1–50 prior beats), hard vs soft blot arrival, auto-chaining, seed |
| **Mood** | ten presets, a 0–1 pressure dial, ink palette. Changing mood mid-film sends a direction, never a new session |
| **Music** | ten genres, **pinned** (the track is conditioning audio: every chunk is generated against the next window of it) or **generated** (the model writes the score), track URL, dropped file |
| **Camera** | which moves may be used, angles per blot (0–4), orbit resolution and length, circle twice, handover policy |
| **Budget** | session and daily caps, session length, dry run |
| **Vision** | the OpenRouter model and the prompt that turns a blot into a beat |

A **share link** reproduces a run — recipe, mood, music, camera and budget — from
a URL. `#watch=1` hides the configuration so the film can sit on a screen.

### One trade to know about

Pinning a track replaces the model's own dialogue, foley and room tone: the
source PCM is what plays. That is the price of the picture being conditioned on
your music, and it is why the switch exists rather than being hidden.

---

## Recording and export

The browser only ever holds a `MediaStream`, so the file is written on the client.
Chrome is tried with an mp4 container first, falling back to webm; if webm is what
you get, **Download** pipes it through the local ffmpeg to a real h264/aac mp4
with the moov atom at the front, which is what a social platform will accept.
`/api/health` reports whether ffmpeg was found.

Nothing is recorded until a session goes live, and the recording spans the whole
chain, so one run is one file.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite client + the proxy |
| `npm test` | Client tests (vitest) and server tests (node --test) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build into `dist/` |

### Dev dependencies

The machine-level npm config on this machine sets `omit=dev`. This project cannot
run without vite, vitest and concurrently, so install with:

```bash
npm install --include=dev
```

`npm run dev` and `npm test` check for them first and say so rather than failing
with `vitest: command not found`.

---

## Layout

```
server/index.mjs           proxy: fal allowlist (wma.fal.run, queue, storage),
                           vision route, same-origin media relay, ffmpeg remux
src/state.ts               versioned settings, pricing, run estimator
src/ink/                   rng, recipe -> op log, canvas, fold geometry, renderer
src/presets/               10 moods, 10 music genres, 7 keyframed camera moves
src/rail/                  blot queue, lenient vision reading, prompt composer
src/angle/                 Multi Angle payload builder, final-pose frame grab
src/stream/                wire protocol, session, scheduler, chaining, budget
src/record/                MediaRecorder wrapper with an mp4-first fallback
src/studio/                the orchestrator and its browser wiring
src/ui/                    rail, HUD, controls, shell, poster, manual mode
```

## Testing

420 client tests and 32 server tests. The interesting ones are the ones that
protect money and continuity:

* the protocol builders can only produce messages the `additionalProperties:
  false` schema accepts, and script limits (≥3 s between end images, 16 end
  images, 64 beats) are enforced before anything is sent
* the scheduler never sends two destinations for one chunk, retries a `queue_full`
  rejection without losing the blot, and softens a content rejection once before
  dropping the blot rather than stalling the film
* the budget guard stops a run at the cap, including the 60 second session floor
  and a server-declared ceiling
* the chaining policy retires a session *before* the server's ceiling, because
  our handover is invisible and the server's is not
* an end-to-end server test converts a generated webm through the real ffmpeg and
  probes the result for an h264 stream

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Not ready: FAL_KEY" | Missing from `.env`; restart `npm run dev`. |
| The film starts then stops at ~2 minutes | The server declared a session ceiling. Leave auto-chaining on. |
| "the rail ran dry" | The vision model is slow or failing. The film continues without new blots. |
| A blot is dropped | Its upload, vision call or orbit failed twice. The rail invents another. |
| Audio stops mid-film | The pinned track ran out. The rest of that session has no score. |
| A webm with no mp4 | ffmpeg was not found on `PATH`. |

## Legal

* Generated video may be used commercially; see fal's terms.
* Only pin music you have the right to broadcast. See `docs/music.md`.
* `FAL_KEY` never reaches the browser: it lives in the server's `.env` and is
  attached by the proxy.
