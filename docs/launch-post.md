# Launch post (draft)

Paste-ready draft for the H3 Max Director campaign. The campaign asks for
something built on the model and a launch post tagging **@fal**. Edit the voice
to taste; keep the specifics, because they are the part that is true.

---

## The post

> We built **Ink & Film** on @fal's H3 Max Director.
>
> Real ink blots — dropped, smeared and folded on paper, then mirrored like a
> Rorschach — get imagined by a vision model and then *become one continuous
> film*. No cuts, no clips stitched together: one stream that never restarts.
>
> Two things we had to solve to make it work:
>
> **1. A Director session is not resumable, so a long film is a chain.** Just
> before the server's ceiling we retire the session and open a new one on the
> previous stream's exact final frame. The seam is invisible, and the recording
> spans all of it, so the export is one file.
>
> **2. Director has no camera controls — so we built them next door.** We drive
> `minimax/h3-max/multi-angle/image-to-video` to orbit each blot into consistent
> viewpoints, extract the held final pose of each take, and hand those stills to
> the stream as `end_image_url` destinations. The film circles the same ink
> sculpture through real camera positions before moving on to the next blot.
>
> Mood and music are inputs, not decoration: pick a mood and a genre and the
> stream is conditioned on the pinned track itself, with the picture cut to it.
>
> Play it, or press Start and direct your own: <link>
>
> #fal #H3MaxDirector

---

## Short version

> Real ink + a vision model + @fal H3 Max Director = one unbroken film that never
> restarts. We chain sessions on their own last frame for continuity, and borrow
> Multi Angle to orbit each blot so the stream can circle it in 3D.
> <link>

---

## What to attach

1. `docs/demo.mp4` — a 60–90 second capture of a real run. Include the seam: show
   the HUD counter rolling past a handover so the "continuous" claim is visible
   rather than asserted.
2. A poster: **Poster** in the top bar composes a 1600×900 still of the run's
   blots, mood, score and session count.
3. Optionally the blot strip on its own — the raw ink reads well as a before/after
   next to the film.

## Capture recipe

1. Start in **Dry run** and rehearse the framing, then turn it off.
2. Budget: keep `sessionCapUsd` low and the session length at 120 s so a capture
   is cheap and repeatable.
3. Resolution 768p, 16:9, `hard` arrival, 2 angles per blot: the default is the
   most legible configuration on video.
4. Mood: start **Dreamlike**, switch to **Menacing** about halfway — the mood
   change lands as a direction mid-take and is the clearest demonstration that
   the film is being directed rather than assembled.
5. Music: pin something with a strong pulse if you want the conditioning to be
   audible, or use a generated score if you want the model's own foley.
6. Record the screen, not just the file: the rail, the cost meter and the
   handover counter are the evidence.

## Claims worth making, and why

| Claim | Evidence in the app |
|---|---|
| One continuous stream | `chunk` messages with a rising `chunk_index`, no restart between them |
| Continuity across the server's ceiling | the log line "handing over", then a second `configure` opening on the last frame |
| Real camera moves | the orbit diagram in the Camera panel is drawn from the keyframe values actually sent |
| Music conditions the picture | a pinned `audio_url` on the session, and the world prompt saying the film is cut to it |
| The blots are physical | a seed replays the same painting exactly; the share link reproduces it |
