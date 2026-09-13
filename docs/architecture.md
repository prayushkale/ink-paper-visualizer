# Architecture and the verified API surface

The whole design is shaped by two facts about H3 Max Director that are easy to get
wrong, and one about the Multi Angle endpoint next to it. Everything here was read
off fal's own machine-readable surfaces, and the files that depend on it are noted
so a future change has one place to land.

## Fact 1 — Director is a WebRTC session, not a queue

`POST https://fal.run/...` and `fal.subscribe` do not work on it. The session is a
WebRTC peer held open by the browser:

```ts
fal.realtime.open(wma('minimax/h3-max/director'), {
  receive: ['video', 'audio'],       // both tracks must be in the offer
  onMedia, onData, onState, onError,
});
```

* Auth and signalling go through our own proxy (`/api/fal/proxy`), which is why
  `server/index.mjs` implements the documented `x-fal-target-url` contract and
  allowlists `wma.fal.run` for `POST /session`, `/ice` and `/session/heartbeat`
  only.
* fal names its own failures in `detail` (a string, or the Pydantic array), but
  the browser client only reads `message` and would otherwise show the bare HTTP
  status text. The proxy rewrites a non-2xx JSON body into a legible `message`
  (`legibleFalError`), which is why a storage refusal reads "Error initiating
  upload" in the UI instead of "Internal Server Error".
* `receive` has to name both kinds *before* the offer is created: a WebRTC answer
  cannot introduce a media section the browser did not offer.
* The managed handle queues `send()` until the data channel is live, in order, so
  `configure` can be handed over immediately.
* Sessions are **not resumable**. A dropped peer connection cannot be recovered;
  the only way to continue is a new session.

Files: `src/stream/transport.ts`, `src/stream/session.ts`, `server/index.mjs`.

## Fact 2 — `configure` is `additionalProperties: false`

Verified against `https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json`.
The client `configure` message accepts exactly:

`type`, `prompt_version`, `protocol_version`, `prompt`, `image_url`,
`end_image_url`, `resolution`, `aspect_ratio`, `memory`, `seed`, `audio_url`,
`audio_bitrate`, `script`

An unknown field is an error, not a hint. That is why every message is built
through `src/stream/protocol.ts` and why `protocol.test.ts` asserts the key set of
every builder against the schema's own field list.

### Immutable for the life of a session

`resolution`, `aspect_ratio`, `image_url`, `memory`, `seed`, `audio_bitrate`.
Changing any of them means a new session, which is why the UI locks those
controls while a run is open.

### Limits worth encoding

| Limit | Value | Where it is enforced |
|---|---|---|
| prompt length | 50,000 chars | `buildConfigure`, `buildPrompt` |
| script beats | 64 | `validateScript` |
| end images per script | 16 | `validateScript` |
| spacing between end images | ≥ 3 s | `validateScript` |
| chunk length | 10 s (server-reported, 5–15) | scheduler cadence |
| memory | 1–50, default 12 | `buildConfigure` clamps |
| pending / queued scripts | 4 / 4 | plan-ahead scheduler |
| audio source | 600 s | `MusicBed` |
| one session per machine | true | a second run is refused |

### The two hooks everything hangs off

* **`image_url`** — the *exact first frame*, and the opening prompt expansion sees
  it. This is how a session opens *inside* a realised blot, and how a chain opens
  on the previous stream's last frame.
* **`end_image_url`** — the *exact final frame* of the chunk that ends at a given
  offset. This is how a blot becomes a destination the picture must arrive at. It
  is always a photograph: the ink blot is realised by the image model first (Fact
  4). It cannot be combined with `script` on the same message, and `audio_url`
  behaves as conditioning audio (`replace` / `queue`), not as a decoration.

## Fact 3 — Multi Angle is a sibling endpoint, not a Director mode

The Director schema has **no camera field**. Camera control lives at
`minimax/h3-max/multi-angle/image-to-video`, which is a normal queue endpoint:

* `image_url` (required), `camera_trajectory` of `{time, azimuth, elevation, distance}`
  keyframes, `duration` 5–15, `resolution` 480P/768P/1080P, `seed`,
  `prompt_expansion_mode` (**only `balanced` or `quality`** — `fast` is invalid
  here), `enable_safety_checker`.
* It holds the first pose before its first keyframe and the last pose after its
  last one, so the *final frame* of a take is a stable arrival view. That is the
  frame the studio extracts, and it is what a *turn* handover opens the next
  session on.
* There is no `aspect_ratio`: output inherits the ratio of the input image, which
  is why blots are rendered at the session's aspect ratio in the first place.
* 1080P is a latent refinement of a 768P source, not native detail.

Files: `src/angle/multiAngle.ts`, `src/angle/extract.ts`, `src/presets/camera.ts`.

## Fact 4 — the video model is handed photographs, not paintings

Director animates the image it is given. An ink blot handed in as `image_url` or
`end_image_url` is therefore *the picture*, and every beat of the film arrives on
an animated painting no matter how firmly the prompt says otherwise. So the blot
never reaches Director. Each one is realised as a photograph first:

* `fal-ai/flux-2/turbo/edit` (a normal queue endpoint, allowlisted in
  `server/index.mjs`) is handed the hosted blot and the vision model's reading,
  and asked to repaint the painting as a photograph of what it depicts.
* The blot itself is shown for `BLOT_HOLD_MS` (600 ms) on its rail card, and then
  the photograph takes over. It is never shown over the stage: the stage holds
  the newest *photograph* while the film is being prepared and nothing once the
  film is live, because a still of the ink laid over the stream interrupts the
  picture that was painted, and the ink already has the rail card and the
  full-screen viewer. The one still that does sit over the stage while the film
  is running is the film's own last frame, held across a session seam (see
  "Chaining, end to end") - never the blot, and never for longer than it takes a
  stream to paint. Nothing about the blot is animated anywhere: the beat
  machinery in `src/ink/paintReel.ts` survives only for the lab page.
* `image_url` (the session's first frame), every `end_image_url` destination and
  every Multi Angle input are that photograph. `BlotScheduler.destinationsFor`
  reads `blot.imaginedUrl` first and falls back to the blot's own URL only when no
  image model is wired up.

The imagining is the slowest stage of the rail (seconds per blot), so the buffer
the pre-flight insists on is four ready blots and `PREFLIGHT_BUFFER_MS` is long
enough to actually wait for them: a run that opens on one blot is out of blots
before the next one's photograph exists.

Files: `src/stream/imagine.ts`, `src/rail/queue.ts`, `src/studio/studio.ts`,
`src/ui/rail.ts`, `src/ui/arrival.ts`.

## The two invariants the app protects

### One direction per dispatched chunk, one chunk per blot

A direction applies to the next *undispatched* chunk, and generation runs faster
than playback, so several directions in flight collapse into the last one and
blots vanish without an error. The scheduler therefore opens its gate only when a
chunk arrives carrying the `prompt_version` it last sent, and a watchdog reopens
the gate if no acknowledgement ever arrives. A destination the watchdog frees is
sent again once before the film moves on: a lost acknowledgement must not cost
the film the arrival it was heading for, which is the beat.

Each blot is exactly one of those directions. A chunk is ten seconds and the
length is the server's, not ours, so a blot that was given its photograph *and*
two orbit views spent half a minute of film on one idea; the orbit takes are now
camera work for that one shot (and for a *turn* handover) rather than screen
time. The consequence is a throughput requirement rather than a budget one: the
rail has to produce a blot every ten seconds, so nothing about a blot's takes may
gate it - see below.

File: `src/stream/scheduler.ts`, `src/state.ts` (`planDestinations`).

### The meter can stop the film

Director bills per second of generated video with a 60 second floor per session,
so an unattended run spends until the balance is gone. `BudgetGuard` counts
`chunk.requested_duration_seconds` and every orbit take, enforces the session and
daily caps, honours a ceiling the server declares, and stops the stream itself.

File: `src/stream/budget.ts`, `src/stream/chain.ts`.

## The pre-flight

A run opens no session until the rail holds `preparedTarget` ready blots -
twenty of them, a little over three minutes of film - which is a render, an
upload, a vision call and an imagining per blot: about a minute of work with no
picture to show for it.

Every blot therefore runs its **own** pipeline, from the moment it is invented to
the moment it is ready, and each stage is admitted by its own gate
(`renderConcurrency` for the sheets painted on the page's own thread, then
`interpretConcurrency`, `imagineConcurrency`, and `angleConcurrency` for the takes
shot behind a ready blot). A rail that instead steps every blot one stage per pump
moves the whole rail at the speed of the slowest stage in it - five stages at the
pace of one vision call - which is what left the buffer dry inside the first
minute of a film and the last blot playing on. `maxJobs` is the ceiling, and it
sits above the buffer on purpose: the blots still walking their stages are what
hold the buffer up, so a ceiling set to the buffer alone is a pre-flight waiting
for a count that cannot arrive.

A blot is **ready the moment it has its photograph** - the orbit takes for it are
shot in the background while it is already the film's, because a blot only has one
chunk and the rail must be able to produce one every chunk.

`BlotRail.progress` is derived rather than announced — the stage the
least-finished live blot sits in, the blots ready against the target, the camera
takes done against those wanted. The studio polls it on a timer
(`PREFLIGHT_TICK_MS`) because a pump resolves only when the whole rail stands
still, which with a buffer to fill is a minute away, and the overlay is derived
state rather than an event stream. That snapshot is `view.preparing`, drawn over
the stage by `renderPreparing`. A Stop during the
pre-flight sets `startCancelled`, which unwinds `start()` before it can open a
paying session.

Files: `src/rail/queue.ts`, `src/studio/studio.ts`, `src/ui/hud.ts`.

## Chaining, end to end

```
session N live
  ├─ roll a frame every 2 s (scaled to 1344 px)
  ├─ elapsed >= declared ceiling - 5 s  ──┐
  └─ stream_exhausted{session_limit}   ──┤
                                          ▼
                        stop session N -> commit spend
                                          │
              read the last painted frame off the player
                                          │
             hold it over the stage -> upload -> handoff url
                                          │
                       handoff policy 'continue' | 'turn'
                                          ▼
              finalise the recording part -> configure N+1
                          (image_url = handoff, audio_url = same track)
```

Four things about that sequence are what make the seam behave:

* **The frame is read after the session stops, not when the handover is
  decided.** The picture does not stop the instant the handover is decided - the
  session still has finished video waiting ahead of playback - so the frame in
  hand at that moment is, at best, the frame the film ends on. The element is
  holding that frame once the transport has closed, and reading it there means
  the next session continues from the picture the film actually stopped on.
* **That frame is held over the stage until the new stream paints one of its
  own.** The next stream arrives empty, and an element handed a live source with
  no frames yet shows nothing at all. The still is what covers the gap; it comes
  off on the element's first video-frame callback (or `loadeddata`), and a timer
  takes it off anyway if a stream never paints, so a still can never hide a film
  that is playing.
* **The recording part is finalised after the session, not before it.** A
  `MediaRecorder` cannot be handed a second `MediaStream`, so the part has to be
  closed at the seam - but closing it at the decision truncated the outgoing
  picture, and the next part then started from a frame the previous part never
  reached. The recorder stops itself when its stream's tracks end, so it is
  finalised after `stop()`, and two parts join on the same frame: a chained run
  exports one part per session, and the same is true of a user pause.
* **The hold itself is the seam.** A session can only be configured with an image
  that already exists, so the next session cannot be opened on a frame the current
  one has not painted yet: the dead stretch while it paints its first chunk is
  unavoidable without overlapping two paying sessions. Holding the film's own
  last frame is what that stretch is made of. The pinned score is the other
  audible seam - the server sounds the track from its beginning in every session,
  and continuing it would mean uploading a slice of it per handover -
  and it is a known gap rather than a solved one.


## Alpha-API exposure

`fal.realtime.open` is documented as experimental and may change in a minor
release, so the app pins `@fal-ai/client@1.11.0-alpha.3` exactly (the `latest` tag
does not ship `./realtime` at all) and keeps every message shape in
`src/stream/protocol.ts`. A protocol change should be a one-file change plus its
test.

## Deliberate deviations from the original plan

| Planned | Built | Why |
|---|---|---|
| `@fal-ai/server-proxy` for the proxy route | the documented proxy protocol implemented directly | the library's handler calls global `fetch` internally, which made the allowlist untestable and force-JSONed every upstream request |
| Auto-assembly of angle takes into the export | orbit takes are downloadable individually and steer each blot's camera move; the recording exports as one file | a real edit timeline was not worth the risk before the first launch; the continuous film is the deliverable |
| A content sanitizer layer | one automatic softening retry, then the blot is dropped | matches "no guardrail layer for now" while still guaranteeing the film never stalls |
