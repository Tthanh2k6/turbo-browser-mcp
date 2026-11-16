# Security policy

## Supported versions

The latest minor version on npm gets fixes. Older versions do not.

## Reporting a vulnerability

Report it privately through GitHub: https://github.com/Tthanh2k6/turbo-browser-mcp/security/advisories/new

Do not open a public issue for a security problem.

Include the version, the MCP client, the browser mode, and steps or a small page that reproduces it.

This is a one-person project. Reports are handled on a best-effort basis, with no promised response time.

## In scope

- A way around the submit guard: a final-commit action that runs although `allowSubmit` is not set.
- A way out of path confinement: reading or writing a file outside `TURBO_BROWSER_SAVE_ROOT` or the working directory.
- A way around the network guard when it is enabled.
- Exposure of the CDP bridge (`--bridge`) to anything other than the local machine.

## Out of scope

- Sites that detect automation. The server does not hide that the browser is automated.
- Behavior already listed under "Known limits" in the README.
