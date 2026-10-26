# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

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
- Cross-platform CI (Linux, macOS, Windows; Node 20, 22, 24) and a real-Docker isolation job.

### Known limitations

- The container integration tests (`test/docker.integration.test.ts`) were written against the Docker CLI semantics but
  could not be run on the author's machine during the initial build because no Docker daemon was available. Treat
  isolation as **unverified until the CI `docker-isolation` job has passed** on a real daemon.
- Secret exclusion for the container copy is name-based.
- Each block runs in its own container; state is not shared between blocks.

