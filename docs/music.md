# Music beds and licensing

`Ink & Film` can hand a track to the video model as **conditioning audio**
(`audio_url`). That is a genuinely different thing from putting music under a
clip afterwards: every generated chunk is conditioned on the next window of the
recording, and the recording's PCM is what plays. The model's own dialogue,
foley and room tone are replaced by it.

Because that track ends up in a video you may publish, the rights matter more
than they would for background music:

* **Use music you have the right to broadcast.** A track you bought for personal
  listening is not necessarily licensed for a public post.
* **CC0 / public domain sources** are the low-risk default
  ([Free Music Archive](https://freemusicarchive.org) CC0 filters, Pixabay,
  ccMixter). Keep the licence page for anything you publish.
* **Commissioned or your own recordings** are the safest option and the most
  distinctive.
* **Platform libraries** (Epidemic, Artlist and similar) usually permit social
  use on a subscription, but check the terms for AI-conditioned video if you
  monetise the result.

## How the app handles a track

1. Pick a genre, paste a URL, or drop a file.
2. The bytes are read in the browser and uploaded to fal storage, because the
   model fetches `audio_url` itself — a file on your laptop is not reachable.
3. The resulting fal URL is pinned on the session and reported in the Music panel.
4. A genre swap mid-film re-pins and sends an audio-only direction with
   `audio_behavior: "replace"`, so the change lands on the next undispatched chunk.
5. A track longer than the session's `max_audio_source_seconds` (600 s by
   default) is refused with a clear message rather than silently truncated.

## Bundled paths

`assets/music/README.md` lists the per-genre filenames the presets look for. Drop
files there and the genre resolves with no pasting; the folder is empty by
default, and the app falls back to a model-generated score when no track is
available.

## Format

Aim for 128–192 kbps stereo. The session's audio target is Opus at 96, 128 or
192 kbps and it is set once, when the session opens.
