# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-08-28

### Fixed

- **No transcript was being saved at all.** Since 1.2.0, recordings on the
  default model produced a live transcript on screen and an empty transcript
  file on disk — frontmatter and heading, nothing underneath. AssemblyAI only
  returns *formatted* final transcripts when explicitly asked, and the plugin
  had stopped asking; every turn arrived unformatted, and the plugin treats an
  unformatted turn as a live preview rather than something to save. The request
  is restored, so transcripts are written again.

  This affects **1.2.0, 1.2.1 and 1.2.2** on the default English model and on
  Multilingual. Choosing Universal-3.5 Pro in settings avoided it, as did 1.1.2
  and earlier. Audio was never affected: if WAV recording was enabled, those
  meetings can still be recovered from the saved audio.

## [1.2.2] - 2026-08-27

### Fixed

- **Paused recordings were billed for the pause.** AssemblyAI bills streaming on
  session (connected) duration rather than audio sent, and pausing muted the
  microphone while holding the connection open — so a 60-minute meeting paused
  for 20 minutes still billed 60 minutes. A pause now drops the session once it
  outlasts a 60-second grace period. Brief pauses stay connected and keep
  AssemblyAI's accumulated speaker profiles; only a long pause gives those up,
  which means **speaker letters may be reassigned after a long pause**.
  Transcript timestamps continue correctly across the gap.
- A crash mid-recording could bill up to AssemblyAI's 3-hour session cap,
  because nothing sent the terminate signal. The connection now carries a
  server-side inactivity timeout as a backstop.
- **An accidental click outside a setup window no longer abandons the
  sequence.** Meeting setup runs as a chain — type, template, participants,
  description — and clicking the dimmed background dismissed whichever step was
  open. Dismissing the type step aborted everything; dismissing the participants
  step silently produced a note with no attendees. All five windows now ignore
  background clicks. Escape still cancels deliberately, including where it is
  offered as a real choice ("use built-in default", "keep default name").

## [1.2.1] - 2026-08-27

### Fixed

- Attendees selected through a meeting preset went missing from the notes file,
  most often on machines running Templater. The plugin wrote them correctly
  mid-session, but a later full-file write — a Templater template that prompts
  resolves after the plugin's own modals, and an open editor can flush a stale
  buffer — overwrote the frontmatter. Attendees are now re-asserted as the last
  write when a recording stops, using the editor-aware
  `FileManager.processFrontMatter`, which merges keys instead of replacing the
  frontmatter block.
- A preset saved by an older build could carry no `participants` field at all.
  `data.json` is untyped at runtime, so the list is now normalised on the way in
  rather than trusting the declared type.
- Failures while applying a preset or finishing note setup are now surfaced as a
  notice. That chain is fire-and-forget, so an unhandled rejection previously
  vanished and the note silently lost its attendees.

### Changed

- `minAppVersion` raised to 1.4.4, the release that introduced
  `FileManager.processFrontMatter`.

## [1.2.0] - 2026-08-25

Never released on its own; these changes shipped as part of 1.2.1.

### Added

- **Transcription model setting.** The streaming model is now selectable across
  the three models AssemblyAI currently documents, defaulting to
  `universal-streaming-english` at $0.15/hr. Speaker diarization and keyterm
  prompting work on all of them, so the cheaper default gives up transcription
  accuracy only, not speaker labels.
- Speaker labels are on by default. AssemblyAI is now the sole source of speaker
  attribution; a one-time settings migration enables it for existing installs.

### Fixed

- **The pinned `u3-rt-pro` model was retired by AssemblyAI on 2026-09-02** and
  silently redirected to the three-times-pricier `universal-3-5-pro`. The alias
  is gone, and any unrecognised saved model now falls back to the default rather
  than being sent verbatim.
- AssemblyAI's end-of-session speaker corrections (`SpeakerRevision`) were
  discarded: the socket was closed immediately after `Terminate`, while the
  correction arrives roughly 400 ms later. The client now waits for the
  `Termination` handshake, capped so a dead connection cannot wedge the stop
  path, and rewrites the transcript with the corrected labels.
- Turns shorter than about a second are labelled `PENDING` by AssemblyAI because
  there is too little audio to identify a speaker. That sentinel was written into
  transcripts as `**[Speaker PENDING]**` and also suppressed the next genuine
  speaker label. It is now treated as unknown.
- README advertised $0.0025/min while the pinned model had billed at $0.0075/min
  since v1.1.0. Cost is now stated per model.

## [1.1.2] - 2026-06-12

### Fixed

- API key is stored per device in local storage rather than in the synced
  `data.json`, which broke transcription across machines.
- Clearer endpointing labels and a better default.

## [1.1.1] - 2026-06-12

### Fixed

- `keyterms_prompt` is sent as a single JSON array rather than repeated query
  parameters, which AssemblyAI rejected — transcription failed outright whenever
  key terms were configured.

## [1.1.0] - 2026-06-11

### Added

- Meeting description modal, threaded into generated file names.
- Native speaker diarization and keyterm boosting.

## [1.0.0] - 2026-06-11

### Added

- First release of the self-contained plugin. Audio is captured inside Obsidian
  (microphone plus optional system loopback) and streamed directly to
  AssemblyAI. No server, no executable, nothing to install beyond the plugin.

### Removed

- The Python backend and standalone desktop application.

[1.2.2]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.2.2
[1.2.1]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.2.1
[1.1.2]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.2
[1.1.1]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.1
[1.1.0]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.0
[1.0.0]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.0.0
