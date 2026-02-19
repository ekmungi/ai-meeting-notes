# Example Project CLAUDE.md

This is an example project-level CLAUDE.md file. Place this in your project root.

## Project Overview

- The goal of this project is to build a AI meeting transcription application that can work both standalone and as a Obsidian Plugin.
- Make decisions on the best possible architecuture based on simplicity and quality of code.
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
src/
|-- app/              # Next.js app router
|-- components/       # Reusable UI components
|-- hooks/            # Custom React hooks
|-- lib/              # Utility libraries
|-- types/            # TypeScript definitions

```

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

Read and store Project information at `./.claude/pm/`:
- `decision-log.md` - Architecture decisions
- `known-issues.md` - Bug tracking
- `feature-backlog.md` - Roadmap
- `session-log.md` - Development history
- `./.claude/pm/research/YYYYMMDD_Descriptive_Name` - Technical research
- `./.claude/pm/plans/project-plan_V#.md` - Project plan with version number

Update these files as we work.


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
