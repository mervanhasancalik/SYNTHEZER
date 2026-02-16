# Contributing to Synthezer

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. **Fork** the repository and clone your fork
2. **Install** dependencies: `npm install`
3. **Run** in development mode: `npm run dev` (or server-only: `npm run server`)
4. The app runs at `http://localhost:8090` by default

## Architecture Note

The frontend is a single-file SPA (`frontend/index.html`) — this is intentional, not accidental. We use a zero-build-step architecture for maximum simplicity. There is no bundler, no framework, and no compile step.

## Making Changes

1. Create a feature branch: `git checkout -b my-feature`
2. Make your changes
3. Test locally with `npm run dev`
4. Commit with a clear message describing the change
5. Push to your fork and open a Pull Request

## Code Style

- **JavaScript:** camelCase for variables and functions, `const`/`let` only (no `var`)
- **Database columns:** snake_case
- **HTML IDs/classes:** kebab-case
- **Commits:** Short imperative subject line (e.g., "Fix chip duplication on import")

## Project Structure

| Path | Purpose |
|------|---------|
| `serve.js` | Express server entry point |
| `frontend/index.html` | Entire frontend SPA |
| `routes/` | API route handlers |
| `lib/` | Core libraries (AI, DB, prompts) |
| `db/` | Schema and seed data |
| `electron/` | Desktop wrapper |

## What to Work On

- Check open issues for bugs or feature requests
- Small improvements to docs, error messages, or UX are always welcome
- For large changes, open an issue first to discuss the approach

## Local Data

Synthezer is local-first. All user data stays in `~/.Synthezer/synthezer.db`. Never introduce external telemetry, analytics, or network calls that the user didn't explicitly configure.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and constructive.
