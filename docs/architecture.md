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
  it. This is how a session opens *inside* a blot, and how a chain opens on the
  previous stream's last frame.
* **`end_image_url`** — the *exact final frame* of the chunk that ends at a given
  offset. This is how a blot becomes a destination the picture must arrive at.
  It cannot be combined with `script` on the same message, and `audio_url` behaves
  as conditioning audio (`replace` / `queue`), not as a decoration.

## Fact 3 — Multi Angle is a sibling endpoint, not a Director mode

The Director schema has **no camera field**. Camera control lives at
`minimax/h3-max/multi-angle/image-to-video`, which is a normal queue endpoint:

* `image_url` (required), `camera_trajectory` of `{time, azimuth, elevation, distance}`
  keyframes, `duration` 5–15, `resolution` 480P/768P/1080P, `seed`,
  `prompt_expansion_mode` (**only `balanced` or `quality`** — `fast` is invalid
  here), `enable_safety_checker`.
* It holds the first pose before its first keyframe and the last pose after its
  last one, so the *final frame* of a take is a stable arrival view. That is the
  frame the studio extracts and hands to the stream.
* There is no `aspect_ratio`: output inherits the ratio of the input image, which
  is why blots are rendered at the session's aspect ratio in the first place.
* 1080P is a latent refinement of a 768P source, not native detail.

Files: `src/angle/multiAngle.ts`, `src/angle/extract.ts`, `src/presets/camera.ts`.

## The two invariants the app protects

### One direction per dispatched chunk

A direction applies to the next *undispatched* chunk, and generation runs faster
than playback, so several directions in flight collapse into the last one and
blots vanish without an error. The scheduler therefore opens its gate only when a
chunk arrives carrying the `prompt_version` it last sent, and a watchdog reopens
the gate if no acknowledgement ever arrives.

File: `src/stream/scheduler.ts`.

### The meter can stop the film

Director bills per second of generated video with a 60 second floor per session,
so an unattended run spends until the balance is gone. `BudgetGuard` counts
`chunk.requested_duration_seconds` and every orbit take, enforces the session and
daily caps, honours a ceiling the server declares, and stops the stream itself.

File: `src/stream/budget.ts`, `src/stream/chain.ts`.

## Chaining, end to end

```
session N live
  ├─ roll a frame every 2 s (scaled to 1344 px)
  ├─ elapsed >= declared ceiling - 5 s  ──┐
  └─ stream_exhausted{session_limit}   ──┤
                                          ▼
                              grab frame → upload → handoff url
                                          │
                       handoff policy 'continue' | 'turn'
                                          ▼
                     stop session N → commit spend → configure N+1
                          (image_url = handoff, audio_url = same track)
```

The recording is started once and spans the chain, so one run is one file.

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
| Auto-assembly of angle takes into the export | orbit takes are downloadable individually; the recording exports as one file | a real edit timeline was not worth the risk before the first launch; the continuous film is the deliverable |
| A content sanitizer layer | one automatic softening retry, then the blot is dropped | matches "no guardrail layer for now" while still guaranteeing the film never stalls |
