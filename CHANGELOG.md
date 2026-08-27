# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.1]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.2.1
[1.1.2]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.2
[1.1.1]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.1
[1.1.0]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.1.0
[1.0.0]: https://github.com/ekmungi/ai-meeting-notes/releases/tag/1.0.0
