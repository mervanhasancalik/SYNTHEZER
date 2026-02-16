# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.0.x   | Yes       |
| < 3.0   | No        |

Only the latest release receives security updates.

## Reporting a Vulnerability

**Preferred method:** Use [GitHub Security Advisories](../../security/advisories/new) via the "Report a vulnerability" button on the Security tab. This keeps the report private until a fix is available.

If the issue is not sensitive, you may also open a regular [GitHub issue](../../issues/new).

**Do not** disclose security vulnerabilities in public issues or discussions before a fix is released.

### What to Include

- Steps to reproduce the vulnerability
- Affected version(s)
- Potential impact or severity assessment
- Any suggested fix (optional)

## Scope

The following are in scope for security reports:

- Synthezer desktop application
- Express backend server
- Electron wrapper and IPC handling
- Bundled dependencies

## Out of Scope

- User-configured AI gateways or providers (OpenClaw, Ollama, etc.)
- Tailscale network configuration
- Third-party services or infrastructure
- Issues that require physical access to the user's machine

## Credit

Contributors who report valid security issues will be credited in the release notes. If you prefer to remain anonymous, let us know in your report.
