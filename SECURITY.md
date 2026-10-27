# Security Policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/zuhairhalawa/ReadmeProof/security/advisories/new)
for this repository. Do not open a public issue for an unfixed vulnerability.

Include the readmeproof version (`readmeproof --version`), your OS and Docker version, and a minimal README or
project that reproduces the problem. You can expect an acknowledgement within a few days. Fixes ship as a patch
release with a note in [CHANGELOG.md](CHANGELOG.md).

Supported versions: the latest published `0.x` release.

## Threat model

readmeproof's input is a README (and the project around it) from a source you may not trust. The goals are:

1. **Reading a README must never run anything.** `check` and `list` parse Markdown and read bounded files. They do not
   execute README commands, do not run repository scripts (`package.json` scripts are only *named*, never run), do not
   import project code, and do not use the network.
2. **Running README code must never touch the host.** `verify` is the only path that executes README code, and it does
   so only inside a locked-down Docker container. There is no fallback to running on the host.
3. **README text must never steer the tool.** Instructions embedded in a README (including text aimed at AI agents) are
   data; nothing in readmeproof interprets them. Annotations can only assert and constrain, never grant privileges.
4. **Nothing leaves the machine.** No telemetry, no uploads, no AI API. The only network access is the opt-in
   `--network` container flag and the optional `--pull`, which is performed by the Docker daemon.

## What is enforced (and how it is tested)

| Guarantee | Mechanism | Tests |
| --- | --- | --- |
| No host execution | Execution code path only calls `docker`; missing Docker yields `UNAVAILABLE`, exit 3 | `verify.test.ts` (availability matrix) |
| Network off by default | `--network none`; `bridge` only with the `--network` flag; annotations cannot enable it | `docker.simulated.test.ts`, `verify.test.ts`, `hostile.test.ts` |
| No privileges | `--cap-drop ALL`, `no-new-privileges`, non-root `1000:1000`, no `--privileged`/devices/host namespaces | `docker.simulated.test.ts` forbids dangerous flags |
| No host mounts or socket | No `-v`/`--mount`/volumes; workspace is streamed as tar over stdin into tmpfs | `docker.simulated.test.ts`, integration tests |
| No inherited secrets | Container gets a fixed env list; the docker client gets an allowlisted env | `docker.simulated.test.ts` |
| Sanitized copy | `.git`, `.env*`, keys, `.npmrc`/`.netrc`, cloud credential dirs, `node_modules`, symlinks, special files excluded; file/size caps | `workspace.test.ts`, `verify.test.ts` |
| Resource limits | Memory (swap off), CPUs, PIDs, nofile, tmpfs sizes, per-block timeout with `docker kill`, bounded output with kill on runaway output | `docker.simulated.test.ts`, integration tests |
| Path traversal / symlinks | Links are contained to the project boundary lexically and after `realpath`; the copy never follows symlinks | `checks.test.ts`, `hostile.test.ts`, `workspace.test.ts` |
| Hostile Markdown | 2 MiB file cap, parser nesting limit, caps on blocks/links/spans, bounded regex input, bounded shell tokenizing | `hostile.test.ts` |
| Terminal injection | Control characters, ANSI escapes and bidi overrides in README or container output are escaped before printing | `hostile.test.ts` |

The **real Docker integration tests** (`test/docker.integration.test.ts`, suite "REAL DOCKER integration (actual
containers)") start actual containers and assert these properties from *inside* the container and from the daemon
(`docker inspect`): non-root uid, no network interface but loopback, read-only root filesystem (probed on a
world-writable path, so file permissions cannot mask a missing `--read-only`), empty capability bounding set,
`NoNewPrivs`, denied `mount`/`chown`/clock/sysctl, no Docker socket or host mounts, no inherited environment, a wide
secret-file matrix that never arrives (canary content searched for inside the container), host project unchanged,
time limit, bounded and runaway output, kernel OOM kill at the memory limit (exit 137 and `oom_kill` recorded in the
container's cgroup), measured CPU throttling at `--cpus 0.5`, PID limit, and container removal after normal, failing,
timed-out and output-flooded runs. Both cgroup v1 and v2 hosts are handled.

Tests in `*.simulated.test.ts` and the suites labelled `SIMULATED` use an in-memory `FakeDocker`; they check the
orchestration and the exact `docker run` arguments but start no container and prove nothing about isolation.

When Docker is unavailable the real tests are **skipped with a loud message, and a skipped run proves nothing about
isolation**. With `READMEPROOF_DOCKER_TESTS=1` "Docker unavailable" is a failure instead. `npm run test:docker`
(`scripts/docker-proof.mjs`) goes further and fails unless the daemon is a Linux daemon, every declared real test ran
and passed (none skipped), the daemon's own event log shows the containers were started, and none was left behind.
`npm run pack:smoke` with `READMEPROOF_DOCKER_TESTS=1` additionally requires the **installed** executable to pass the
same kind of isolation probes in real containers. CI runs both on `ubuntu-24.04`.
## Known limitations and non-guarantees

- **Docker is not a perfect sandbox.** Containers share the host kernel. A kernel or runtime vulnerability can allow an
  escape. For READMEs from sources you do not trust at all, run readmeproof inside a disposable VM or use a stronger
  runtime (rootless Docker, gVisor, Kata Containers).
- **`--network` removes network isolation.** The container joins the default bridge and can reach the internet, your LAN
  and cloud metadata endpoints. It is opt-in per invocation and never settable from a README.
- **Secret exclusion is heuristic.** Files are excluded by name and directory (see `src/workspace.ts`). Secrets in
  normally named files are copied into the container. Run against a clean checkout or narrow `--root`.
- **The Docker daemon is trusted.** `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG` are forwarded to the docker
  client. If they point at a remote daemon, the sanitized project copy is sent there.
- **A PASS is not a safety verdict.** A hostile example can print whatever its own assertions expect. PASS means the
  README's code, run in a clean sandbox, met its own declared assertions.
- **Result markers can be forged by the README's own code.** The container reports created files and the exit status
  through per-run random markers on stdout. Code running in the container can in principle read them; this can only make
  that README's own verification wrong, not escape the container.
- **Resource limits are per container.** Many blocks run one after another; the time limit applies to each.
- **Static checks read local files.** They stay inside the project boundary and never follow symlinks out of it, but a
  README that links to a huge in-project file will make `check` read it (anchors are only checked in Markdown files up to
  2 MiB).

## Hardening tips

- Run `verify` in CI or a VM for third-party READMEs, with a clean checkout and `--root` pointing at it.
- Keep `--network` off; if an example needs dependencies, vendor them or use an image that already has them.
- Prefer pinned image digests: `--image node:22-bookworm-slim@sha256:...`.
- Use rootless Docker where possible.

## Supply chain

Runtime dependency: `markdown-it` only. Development dependencies: TypeScript and type packages. The published package
contains `dist/`, `README.md`, `LICENSE`, `SECURITY.md` and `CHANGELOG.md`; `npm run pack:smoke` verifies this and scans
the tarball for secrets and personal paths.

