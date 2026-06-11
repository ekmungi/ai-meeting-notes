# AI Meeting Notes

## Plugin Priority

| Layer | Skills |
|-------|--------|
| Primary | superpowers: TDD, systematic-debugging, writing-plans, brainstorming, verification |
| Secondary | jeeves: product-management, meeting-prep, exec-comm |

## Project Overview

- The goal of this project is to build a self-contained AI meeting transcription Obsidian plugin.
- Audio is captured inside the plugin (mic + optional system loopback) and streamed directly to
  AssemblyAI Universal-Streaming v3 -- no server, no standalone app, nothing to install beyond the
  plugin (D063, supersedes the prior dual-client/Python-backend architecture).
- Make decisions on the best possible architecture based on simplicity and quality of code.
- Ask questions to clarify context.

## Critical Rules

### 1. Code Organization

- Many small files over few large files
- High cohesion, low coupling
- 200-400 lines typical, 800 max per file
- Organize by feature/domain, not by type

### 2. Code Style

- No emojis in code, comments, or documentation
- Immutability always - never mutate objects or arrays
- No console.log in production code
- Proper error handling with try/catch
- Input validation with Zod or similar

### 3. Testing

- TDD: Write tests first
- 80% minimum coverage
- Unit tests for utilities
- Integration tests for APIs
- E2E tests for critical flows

### 4. Security

- No hardcoded secrets
- Environment variables for sensitive data
- Validate all user inputs
- Parameterized queries only
- CSRF protection enabled

## File Structure

```
obsidian-plugin/             # The entire app -- a self-contained Obsidian plugin (TypeScript)
|-- src/
|   |-- main.ts              # Plugin entry: state machine, ribbon/status-bar, session factory
|   |-- settings.ts          # Settings tab UI
|   |-- *-modal.ts           # Meeting-type / participants / template-picker modals
|   |-- transcript-view.ts   # Live transcript leaf view + file writing
|   |-- floating-indicator.ts
|   |-- audio/               # In-plugin capture pipeline
|   |   |-- capture.ts       #   getUserMedia mic + Electron desktop-capture loopback
|   |   |-- pipeline.ts      #   AudioWorklet graph, resample to 16kHz mono PCM
|   |   |-- devices.ts  silence-monitor.ts  wav-writer.ts  frame-bus.ts  pcm-utils.ts
|   |-- transcription/       # AssemblyAI streaming
|   |   |-- assemblyai-client.ts  # v3 WebSocket client + reconnect
|   |   |-- turn-handler.ts  recording-session.ts
|   |-- shared/              # types, yaml-builder, merge-logic, format-utils, crypto
|   |-- settings-migration.ts
```

Audio path: capture (mic + loopback) -> pipeline (resample to PCM) -> frame-bus ->
assemblyai-client (WebSocket) -> turn-handler -> transcript file + live view.

## Key Patterns

### API Response Format

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}
```

### Error Handling

```typescript
try {
  const result = await operation()
  return { success: true, data: result }
} catch (error) {
  console.error('Operation failed:', error)
  return { success: false, error: 'User-friendly message' }
}
```

## Project Management

Docs are split by purpose (global convention since 2026-06-06; supersedes the old
"all PM files in `~/.claude/projects/`" rule). Route documentation with `jeeves:project-docs`.

| What | Where | Used for |
|------|-------|----------|
| Tracking docs: plans, designs/specs, features, decisions, issues, research | Obsidian working vault: `<PARA-Projects>/AI Meeting Notes/` (resolve the vault root and PARA folder via `vault-map.md` -- never hardcode) | Human-managed project memory. Index notes (`plan.md`, `features.md`, `decisions.md`, `issues.md`) hold one-line linked rows; detail lives in `plans/`, `features/`, `decisions/`, `issues/`, `Research/`. Docs stay vault-only. |
| Plane board | linked from the project hub note (`plane-project:`) | Tasks ONLY: items needing the user's review, and implementation task lists while building. Never mirror decisions/features/plans/specs as cards. |
| Auto-memory | `~/.claude/projects/C--Users-ekmun-Dev-ai-meeting-notes/memory/` | Claude Code auto-memory ONLY: `MEMORY.md` (auto-loaded pointer/index) plus `feedback_*`, `project_*`, `reference_*`, `user_*` files. Never tracking docs. |
| This repository | `README.md`, `docs/` | Code-adjacent docs that ship with the code (README, architecture notes). Never plans, specs, or PM files. |

Conventions: decisions are named `DNNN` (sequential; check `decisions.md` for the latest).
New design specs and implementation plans go to `plans/`; capability specs to `features/`.

Do NOT store tracking docs in the repository or in the auto-memory folder.
Never commit plan files to git.


## Environment Variables

```bash
# Required
# DATABASE_URL=
# API_KEY=

# Optional
# DEBUG=false
```

## Available Commands

- `/tdd` - Test-driven development workflow
- `/plan` - Create implementation plan
- `/code-review` - Review code quality
- `/build-fix` - Fix build errors

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`
- Never commit to main directly
- PRs require review
- All tests must pass before merge
