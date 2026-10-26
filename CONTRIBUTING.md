# Contributing

Thanks for helping make READMEs more trustworthy. This project treats README contents as **untrusted input**; please
keep that in mind with every change.

## Setup

```console
$ git clone https://github.com/zuhairhalawa/readmeproof.git
$ cd readmeproof
$ npm install
$ npm run typecheck
$ npm test
$ npm run build
```

Requirements: Node.js 20, 22 or 24. Docker is optional (only the isolation tests need it).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `npm test` | Compile everything to `.test-build/` and run the `node:test` suite |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run pack:smoke` | Pack, install into a fresh temp project, run the installed executable, inspect the tarball |

Run a compact failure-only view of an already compiled test run with `node scripts/run-tests.mjs --compact`.

## Layout

| Path | Contents |
| --- | --- |
| `src/markdown.ts`, `src/annotations.ts` | Parsing, line numbers, annotation grammar |
| `src/checks.ts`, `src/shell.ts` | Static checks and a non-evaluating shell tokenizer |
| `src/workspace.ts`, `src/tar.ts` | Sanitized project copy and tar writer |
| `src/docker.ts`, `src/verify.ts` | Container settings, runtime, result markers, assertions |
| `src/report.ts`, `src/cli.ts`, `src/bin.ts` | Output, exit codes, CLI |
| `test/` | Tests; `test/fixtures/` holds realistic READMEs |

## Rules that must not regress

1. `check` and `list` never execute anything and never use the network.
2. Execution only ever happens in a container built by `buildRunArgs` in `src/docker.ts`. Do not add a host fallback.
3. Do not add privileges, mounts, environment variables or network access to containers. `test/docker.test.ts` lists
   forbidden flags; extend that list rather than weakening it.
4. Annotations may assert and constrain only. A README must not be able to loosen any security setting.
5. Missing Docker is `UNAVAILABLE`. Zero executed examples is `NOTHING VERIFIED`. Never report either as a pass.
6. Anything printed that came from a README or container goes through `sanitizeForTerminal`.
7. Every read of untrusted files is size-bounded, and every resolved path is contained to the project root.
8. No telemetry, no uploads, no required AI service, no new runtime dependency without a strong reason.

## Tests

- Add a unit test for every behaviour change; use hostile inputs where relevant.
- Prefer realistic Markdown in `test/fixtures/` over toy strings when testing parsing or checks. Tests copy fixtures to
  a temp directory (`copyFixture`) so the repository's own `.git` never becomes the project boundary.
- Container orchestration is tested with `FakeDocker` (a `DockerRuntime` that emulates the marker protocol).
  Real isolation is tested in `test/docker.integration.test.ts`:

```console
$ docker pull node:22-bookworm-slim
$ npm test
```

When Docker is unavailable those tests are **skipped and say so**. To make "Docker unavailable" an error (as CI does),
set `READMEPROOF_DOCKER_TESTS=1`; this also lets the tests pull the image. `READMEPROOF_TEST_IMAGE` selects another
image and `READMEPROOF_DOCKER` points at another docker binary.

Never describe isolation as verified in a PR unless the integration tests actually ran against a daemon.

## Pull requests

- Keep changes focused; update README, SECURITY.md and CHANGELOG.md when behaviour or guarantees change.
- `npm run typecheck`, `npm test`, `npm run build` and `npm run pack:smoke` must pass on Linux, macOS and Windows
  (CI runs the matrix on Node 20, 22 and 24).
- Source files are ASCII; use escape sequences for special characters.

By contributing you agree that your contributions are licensed under the MIT License.

