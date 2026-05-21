# Security Policy

## Reporting a vulnerability

If you've found a security issue in otterly, please **don't** open a
public GitHub issue. Instead, email:

**harsh.joshi.pth@gmail.com**

Use a subject line that starts with `[otterly-security]` so it doesn't
get buried. Include:

- A description of the issue
- Steps to reproduce
- Affected versions (if known)
- Your assessment of impact

You can expect an acknowledgement within 72 hours. If the issue is
confirmed, a fix and a coordinated disclosure timeline will follow.

## Threat model — what otterly does and doesn't protect

otterly is a local transport layer. Understanding what it does (and
doesn't) helps frame what counts as a vulnerability.

### In scope

- Bugs in the HTTP / WebSocket server that allow unauthorized access
  to local routes (when `OTTERLY_API_KEY` is set)
- Bugs that cause otterly to mis-route requests away from the intended
  `claude` CLI invocation
- Path traversal, command injection, or similar issues in the way
  otterly invokes the local CLI
- DoS vectors in the server (rate limit bypass, queue starvation, etc.)
- Vulnerabilities introduced by the one runtime dependency (`ws`)
  that have a clear otterly-specific impact

### Out of scope

- Anything in the upstream Claude Code CLI itself — please report
  those to Anthropic directly
- The user's choice to expose port 11434 to the public internet
  (this is documented as a bad idea; running otterly without
  `OTTERLY_API_KEY` on a public address is a configuration mistake,
  not a vulnerability)
- The user's choice to share their Claude Code subscription with
  others via otterly (an Anthropic ToS issue, not a security one)
- Bugs in third-party clients (OpenClaw, Cursor, Aider, etc.) that
  happen to use otterly

## Supported versions

Only the latest `0.x` release receives security fixes. Older versions
are not patched.
