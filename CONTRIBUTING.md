# Contributing to otterly

Thanks for considering a contribution. otterly is small, opinionated, and
intentionally narrow in scope — keeping it that way is part of how it
stays useful. Read this once before opening a PR.

## What otterly is and isn't

**otterly is** a thin translator that exposes the local `claude` CLI as
an OpenAI-compatible HTTP server. One runtime dependency (`ws`), ~45 kB,
no telemetry.

**otterly is not** a model, a fork, a prompt-inspection layer, a
multi-tenant gateway, or a cloud service. Contributions that move it
toward any of those are likely to be declined — not because the ideas
are bad, but because they're a different project.

If you're unsure whether your idea fits, open an issue first and ask.

## Welcome contributions

- Bug fixes (with a failing test, ideally)
- Recipes for popular tools (Cursor, Aider, Continue, OpenClaw, LangChain,
  LiteLLM, Vercel AI SDK, etc.) — file under `examples/` or as a README
  section
- Compatibility patches when the `claude` CLI's output shape changes
- Documentation improvements
- Performance improvements that don't add dependencies

## Probably not welcome

- New runtime dependencies (every one of them has to earn its place)
- Cloud / hosted variants
- Prompt logging, content filtering, "moderation"
- Telemetry, analytics, phone-home
- Closed-source distribution channels

## Dev loop

```bash
# Install
npm install

# Tests
npm test

# Type-check + build
npm run build

# Watch mode (re-runs tests on save)
npm run test:watch
```

The test suite is fast (under a second) and runs without any network or
Claude Code installed. Tests live in `tests/`, colocated by area.

You'll need the real `claude` CLI installed and logged in only if you
want to run the examples or test the live integration path.

## Code style

- TypeScript strict mode (already enforced by `tsconfig.json`)
- Two-space indent for `.ts` / `.js`, four-space for Python (none here)
- No semicolons-vs-semicolons or single-vs-double bikeshedding — match
  the file you're editing
- Prefer fewer abstractions over more. If you find yourself building an
  interface for a thing used once, just inline it.

## Pull requests

- Branch off `main`, open the PR back to `main`
- Reference any related issue in the description
- Keep PRs scoped to one thing. A bug fix and a refactor go in separate
  PRs.
- Conventional Commits in the PR title (`feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `refactor:`)
- All tests must pass. CI will block merge otherwise.

## Security issues

Don't open a public issue for security problems. See
[SECURITY.md](./SECURITY.md) for the disclosure address.

## License

By contributing, you agree your contributions will be licensed under the
same MIT license as the project.
