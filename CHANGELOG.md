# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-27

First release (MVP).

### Added

- `readmeproof check`: offline static analysis of README files (relative links, assets, anchors, case mismatches,
  path traversal and symlink escapes, referenced files, package scripts, package-name near misses, annotation syntax)
  with exact `file:line`, evidence and a suggested fix. External links are reported `UNVERIFIED`.
- `readmeproof list`: all code blocks with line ranges, languages, executability and annotations.
- `readmeproof verify`: runs `sh`, `bash`/`shell` and `js` blocks inside disposable Docker containers (no network by
  default, non-root, all capabilities dropped, read-only root, tmpfs workspace streamed over stdin, resource/PID/time
  limits, bounded output, sanitized project copy, fixed environment, forced cleanup). No host fallback.
- Annotation convention (`<!-- readmeproof: name= exit= output= output-exact= stderr= creates= timeout= skip -->`).
- Result model `PASS`/`FAIL`/`SKIP`/`UNVERIFIED`, smoke vs. asserted PASS, `NOTHING VERIFIED` and `UNAVAILABLE`
  verdicts, stable JSON (`schemaVersion: 1`), documented exit codes.
- Cross-platform CI (Linux, macOS, Windows; Node 20, 22, 24) and a mandatory real-Docker job on ubuntu-24.04.

### Known limitations

- Isolation is verified only when the real-container tests actually run: `npm run test:docker` (strict proof that every
  real test executed) and `READMEPROOF_DOCKER_TESTS=1 npm run pack:smoke` (installed executable in real containers).
  A normal `npm test` without a Docker daemon skips those tests and says so; that run does not verify isolation.
- Docker is not a perfect sandbox; see SECURITY.md.
- Secret exclusion for the container copy is name-based.
- Each block runs in its own container; state is not shared between blocks.

