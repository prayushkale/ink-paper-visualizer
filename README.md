# Ink & Film

A live studio for **MiniMax H3 Max Director** on fal.ai.

Real ink blots are painted by a physical simulation, imagined by a vision model,
realised as photographs by an image model, and then made into **one continuous,
unbroken film** that the model streams at 24 fps with native audio. The blots
keep coming, so the film never restarts: each new blot is a destination the
picture has to arrive at, and between arrivals the stream is free to become
whatever the mood and the score suggest.

Two things make it more than a pretty demo:

* **The film is a chain, not a clip.** A Director session is not resumable, so a
  long film is several sessions opened on one another. Each new session opens on
  the previous one's *actual* last frame - read off the player once that session
  has stopped, rather than the frame that happened to be in hand when the
  handover was decided - and that frame is what covers the stage until the new
  stream paints, so the seam continues from the picture the film stopped on and
  is never a dead rectangle.
* **The camera is real.** Alongside Director, the app drives
  `minimax/h3-max/multi-angle/image-to-video` to orbit a realised blot into a set
  of consistent viewpoints, then hands those *stills* to the stream as
  destinations. The result reads as one object explored in 3D rather than a
  slideshow.
* **The blot is a reference, never a picture.** The video model is never handed
  ink: each blot is realised as a photograph first (`fal-ai/flux-2/turbo/edit`),
  and it is that photograph the film opens inside and arrives at. An ink blot
  handed to Director is a painting the model animates; a photograph is a place.

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
| `FAL_KEY` | The Director session, the Multi Angle orbits, the image model that realises each blot, and hosting your blot and music files. |
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
| Flux 2 Turbo Edit (one still per blot) | see fal's page | see fal's page |

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
                        │                                            │
                        │                                            ▼
                        └──────────────────────────► image model ──► a photograph
                                                                        │
                                                    ┌───────────────────┤
                                                    │                   │
                     Multi Angle orbits ──► camera takes ──► handover  │
                                                    │                   │
                                                    ▼                   ▼
             Director session ◄── one destination per dispatched chunk
                    │
                    ├─ chunk telemetry ──► buffer health, cost meter
                    └─ session ceiling ──► handover ──► new session, same picture
```

1. **Ink.** A seed picks the composition of the blot - a lone body with a stub,
   a body low on the sheet with one long arm thrown up across it, arms all round
   it, fronds leaning the same way, a dry sweep set off from one edge, or two
   arms crossing at the middle - then picks tools (pool, drop, streak, curve,
   drag, spray, backrun) and lays down a fold plan of 0–7 vertical/horizontal
   creases at a centre or off-centre position. The retired splatter is not among
   them: it throws a ring of droplets clear of its own blob, so it reads as
   damage to a mark rather than as ink. A blot is **up to seven marks** - the
   engine rolls a count of 1–7 for each blot - and **every mark grows out of the
   body**: a limb is a stroke that opens at the middle of the mass, thins as it
   walks away from it and breaks into flecks at its tip, and the marks left over
   pool as knots along a limb that is already there. That is what makes a blot
   one piece of ink rather than five blots sharing a page. A body that is the
   only thing on the sheet pools where it was pressed, with a ragged edge and a
   spatter or two on it. Pigment comes from the full range at random and is laid
   on a **ramp**: the body takes the deepest colour and the marks walking away
   from it take paler ones, so a page reads from its centre outwards instead of
   arriving as seven unrelated dips. The drawing is held to two rules: no mark is
   thinner than 4% of the short edge, and a blot is grown - fatter, and walked
   clear of whatever edge it was painted into - until it inks at least a fifth of
   the sheet, so the rail never fills with speckle. The sheet is pure white
   because a fold prints the moving flap back over the far half with `multiply`,
   and against a tinted sheet that blend darkens the tint at every crease; white
   leaves the fold showing in the ink alone. The canvas is rendered at the
   stream's aspect ratio, because image-to-video inherits the ratio of the image
   you give it.

   Nothing opens a paid session until the rail holds twenty ready blots — a
   little over three minutes of film, four ready and waiting for every blot the
   film is using — so pressing **Start** runs a pre-flight first: paint, host,
   imagine and realise, several blots at a time. The camera take for a blot that
   rolled a move is shot alongside, in the background, because a blot is ready
   the moment it has its photograph. It takes about a minute, and the overlay
   over the stage names the stage it is in, counts the blots and takes done, and
   runs an elapsed clock, because a long wait looks like a hang otherwise.
   **Stop** during the pre-flight cancels it before a session ever opens.

   The rail is where a run shows its work. A blot is never animated: the card
   holds the ink blot itself for **600 ms** and then hands over to the photograph
   the imagining made of it, keeping the blot in the corner as a reference. The
   stage is not a second rail: while the film is being prepared it holds the
   newest *photograph* (never the ink, which has its card and the full-screen
   viewer) and once the film is live it holds nothing at all.
2. **Imagining.** The vision model — `z-ai/glm-5.3-flash` by default —
   is handed the blot plus the running context (mood, score, camera move, and the
   last several beats) and is asked to find the specific thing the blot already
   looks like, then describe it vividly enough to film. The reply is structured
   JSON whose `prompt` becomes the video direction, and a model that answers in
   prose still produces a usable beat, because a live film cannot stop to fix a
   parse.
3. **Realising.** `fal-ai/flux-2/turbo/edit` is handed the hosted blot and that
   reading, and is asked to repaint the painting as a photograph of what it
   depicts - real material, practical light, no paper, no pigment. It is the
   photograph, not the blot, that the film opens inside and arrives at. The image
   model is a normal queue endpoint, so it goes through the same proxy as
   everything else; a blot it cannot realise is dropped rather than handed on as
   ink.
4. **Orbits.** Multi Angle turns the *photograph* into a keyframed camera take; the
   app extracts the clip's **final pose** (the model holds it to the end) and
   hosts it. That still is a consistent view of the same frozen scene. Only about
   **one blot in five** is given a take - rolled at random from the blot's own
   seed - with the move itself drawn at random from the whole set, at the stream's
   own resolution and **five seconds** long. The clip is told what it is: the
   mood, the score and the blot's own reading go into its prompt, along with the
   rule that the attached frame is already a photograph and stays one. The take is
   **camera work, not screen time**: the move shot for a blot is the move its
   direction asks for, and it is shot in the background while the blot is already
   the film's. The seam between sessions is always the last frame, so the film
   never cuts to a new angle.
5. **The film.** The scheduler sends one direction per *dispatched* chunk,
   carrying the next arrival photograph and the text that describes it. **One blot
   is one chunk**: the picture arrives at the photograph the imagining made of it,
   holds it for those ten seconds and moves on to the next blot. No blot can take
   half a minute of the film, and the rail therefore has to produce a blot every
   chunk - which is why the takes no longer gate a blot's readiness.
6. **Handover.** Just before the server's own ceiling the session is retired, its
   last painted frame is read off the player, and the next session opens inside it;
   if no frame could be captured it opens from the prompt alone rather than cutting
   away. The frame stays held over the stage until the new stream paints one of its
   own, so the gap between two sessions is a still of the film rather than a black
   rectangle. A `MediaRecorder` cannot be handed a second stream, so the seam also
   ends the recording part - finalised *after* the old session stops, so two parts
   join on the same frame: a chained run exports as one file per session.

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
| **Quality preset** | **Low** (default, the cheapest: 480p, no camera moves, one 60s session), **Medium** (768p, a camera move on one blot in five, three minutes) and **High** (1080p, a camera move on one blot in five, ten minutes). A preset writes resolution and the budget; every value stays editable |
| **Stream** | resolution, frame (16:9 / 9:16 / 1:1), memory (1–50 prior beats), hard vs soft blot arrival, auto-chaining, seed |
| **Mood** | ten presets and a 0–1 pressure dial. Changing mood mid-film sends a direction, never a new session |
| **Music** | ten genres, **pinned** (the track is conditioning audio: every chunk is generated against the next window of it) or **generated** (the model writes the score, the default because `assets/music/` ships empty), track URL, dropped file |
| **Camera** | one switch: give some blots a camera move. About **one blot in five** - picked at random, so it might be the second blot and then the ninth - is handed a move rolled from the whole set, and one Multi Angle take is shot for it at the **stream's own resolution**, **5s** long. The move is stamped on the blot, so the reading and the shot agree. The seam between sessions is always the last frame |
| **Budget** | session and daily caps, session length (10s–15m; Director still bills a 60s minimum per session), dry run |
| **Vision** | the OpenRouter model and the prompt that turns a blot into a beat |

**Pause / Play** stops the meter. Pausing ends the Director session (it cannot be
resumed once stopped), finalises the recording, and keeps the frozen frame. Play
opens a fresh session on that exact frame and starts a new recording part, so a
paused film costs a new session minimum when it resumes. Because a session cannot
be rejoined, **each pause produces its own file** — the telemetry lists every
part, each with a **Play** that puts that take back on the stage on a loop (a
session's stream dies with the session, so before that button existed a finished
run left nothing to watch) and a **Download**. **Poster** composes the run's
still and shows it full screen first; the file is only written by the Download
button inside that viewer. **Double-click the film** for fullscreen. A blot on
the rail opens full screen when it is clicked, with its reading and its camera
takes.

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

Nothing is recorded until a session goes live. A `MediaRecorder` is bound to one
stream, so the recording spans exactly one session: a chained or paused run
exports one part per session, each offered separately to play back on the stage
or to download. Each part is closed once its own stream has ended - not when the
handover is decided - so the last frame of one part is the first frame of the
next.

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
src/stream/                wire protocol, session, scheduler, chaining, budget,
                           the imagining that realises a blot as a photograph
src/record/                MediaRecorder wrapper with an mp4-first fallback
src/studio/                the orchestrator and its browser wiring
src/ui/                    rail, HUD, controls, shell, poster, viewer, manual mode
lab.html, src/lab.ts       the blot lab: the engine, full size, off the film's clock
```

## Testing

615 client tests and 44 server tests. The interesting ones are the ones that
protect money and continuity:

* the protocol builders can only produce messages the `additionalProperties:
  false` schema accepts, and script limits (≥3 s between end images, 16 end
  images, 64 beats) are enforced before anything is sent
* the scheduler never sends two destinations for one chunk, gives every blot
exactly one chunk of film, retries a `queue_full` rejection without losing the
blot, and softens a content rejection once before dropping the blot rather than
stalling the film
* a direction nobody confirms is sent again once before the film moves on, so a
lost acknowledgement does not cost the film its arrival at that blot
* a session seam opens the next session on the frame the player actually ended on
  and holds that frame over the stage until the new stream paints, so a chained
  film continues from its own last picture instead of a dead rectangle
* every blot on the rail walks its own pipeline, stage by stage, so a blot waiting
  on the vision model does not hold up a blot that is ready to be painted
* the rail hands a blot over the moment it has its photograph, while the camera
take for a blot that rolled a move is still being shot, because a blot is one
chunk of film
* the budget guard stops a run at the cap, including the 60 second session floor
  and a server-declared ceiling
* the chaining policy retires a session *before* the server's ceiling, because
  our handover is invisible and the server's is not
* an end-to-end server test converts a generated webm through the real ffmpeg and
  probes the result for an h264 stream

### The blot lab

`lab.html` is the ink engine on a page of its own (the dev server serves it at
`/lab.html`). It paints a batch of invented blots at full size through the same
call the rail's `invent` port makes, keeps the batch's seeds in storage so an
edit to `src/ink/recipe.ts` and a reload show the same blots rather than a fresh
handful, and steps any one blot through the beats it is painted in - with the op
log drawn over the ink, which is the view that explains why a sheet looks the
way it does. It talks to no server and spends nothing.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Not ready: FAL_KEY" | Missing from `.env`; restart `npm run dev`. |
| The film starts then stops at ~2 minutes | The server declared a session ceiling, or the `low` quality preset's own 60s cap is in force. Leave auto-chaining on, or pick a longer preset. |
| "The rail ran dry" (a notice in the top right, once a minute at most) | The rail fell behind the film: a blot is one chunk of film, so the rail has to prepare one every ten seconds, and the film runs on its own momentum while it catches up. It clears itself, and every occurrence is in the log. |
| Start sits on "preparing the film" for about a minute | The rail is painting, hosting, imagining and realising its twenty ready blots before the film spends anything. The overlay names the stage and counts the blots and the takes done; Stop cancels it for free. |
| A blot is dropped | Its upload, vision call or orbit failed twice. The rail invents another. |
| "no bundled track at /assets/music/…" | The folder is empty, so the dev server answered with the app's HTML. The run falls back to a model-scored film: drop a file in `assets/music/`, paste a URL, or pick "Model scores it". |
| "the pinned track was not accepted" | The URL reached the session but is not audio the model can condition on. |
| "The stream failed" | The WebRTC peer died, or the server ended the session lease. The session is closed, the recording is kept, and Start opens a fresh one: a Director session can never be rejoined. |
| Audio stops mid-film | The pinned track ran out. The rest of that session has no score. |
| A webm with no mp4 | ffmpeg was not found on `PATH`. |
| A fal call fails as a bare "Internal Server Error" | The proxy rewrites fal's `detail` into the `message` the browser client reads, so a fresh failure should name itself. Check the server console for the upstream body. |

## Legal

* Generated video may be used commercially; see fal's terms.
* Only pin music you have the right to broadcast. See `docs/music.md`.
* `FAL_KEY` never reaches the browser: it lives in the server's `.env` and is
  attached by the proxy.
