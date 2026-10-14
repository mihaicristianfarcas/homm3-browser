# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/mihaicristianfarcas/homm3-browser/security/advisories/new),
not in public issues. Include what is affected, how to reproduce it, and its impact. You'll get an
answer as soon as possible; this is a hobby project, so please allow a few days.

## Scope

In scope: the web server (`server/`), the launcher (`web/`), the deployment scripts and container
setup, and the browser-specific changes to VCMI. For example:

- reaching files outside the web root or the game data folder,
- downloading game files without the key,
- using the WebSocket bridge to reach anything other than the configured lobby,
- anything that lets one player affect another player's browser.

Problems in the VCMI engine or lobby that also exist in desktop VCMI belong to
[VCMI](https://github.com/vcmi/vcmi/security).

## Supported versions

Only the latest release receives fixes.
