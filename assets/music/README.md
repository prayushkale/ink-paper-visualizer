# Music beds

Drop your own tracks here and they will be served at `/assets/music/<name>.mp3`
by the dev server, which means the genre presets resolve without you pasting a
URL every time.

The paths the presets look for, one per genre in `src/presets/music.ts`:

```
trance.mp3  classical.mp3  ambient.mp3  lofi.mp3  jazz.mp3
cinematic.mp3  industrial.mp3  zen.mp3  choir.mp3  synthwave.mp3
```

Anything you put here is read by the browser and then uploaded to fal storage
once per track, because Director fetches `audio_url` itself: a pinned score has
to be reachable from fal, not from your laptop.

Notes:

* Only use music you have the right to broadcast. See `docs/music.md`.
* A track longer than the session's `max_audio_source_seconds` (600 s by
  default) is rejected with a clear message rather than silently truncated.
* Prefer 128-192 kbps stereo: the session's audio target is Opus 96/128/192.
* Nothing here is required. Leave the folder empty and either paste a track URL
  in the Music panel, drop a file onto it, or switch the score to `generated`
  and let Director write the music from the beat prompts.
