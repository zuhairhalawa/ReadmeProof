# readmeproof

Check whether the instructions in your README actually work.

- **Static checks** (offline, no Docker, nothing is executed): broken relative links, missing images and assets, bad
  `#anchors`, referenced files, `npm run <script>` names that do not exist in `package.json`, and package names that
  contradict `package.json`. Exact `file:line` for every finding.
- **Execution checks** (opt-in, Docker only): run README examples inside a disposable, locked-down container and compare
  what really happens with assertions you declare next to the example (exit status, output, created files).
- **Honest results**: `PASS`, `FAIL`, `SKIP`, `UNVERIFIED`. If no example ran, the verdict is
  **NOTHING VERIFIED**, never an all-green result. If Docker is missing, the verdict is **UNAVAILABLE**, never a pass.

No telemetry, no uploads, no AI service. README contents are treated as untrusted input.

> **Status: 0.1.0, not yet published to npm.** The commands below describe the package once released. Until then,
> build from source (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Install

Requires Node.js 20 or newer. Docker is only needed for `verify`.

```console
$ npm install -g @zuhairhalawa/readmeproof
```

Or run it without installing:

```console
$ npx @zuhairhalawa/readmeproof check README.md
```

The executable is called `readmeproof`.

## Quick start

```console
$ readmeproof check README.md
$ readmeproof check . --json
$ readmeproof list README.md
$ readmeproof verify README.md --block quickstart
```

| Command | What it does | Executes README code? |
| --- | --- | --- |
| `readmeproof check [README.md \| DIR]` | Static analysis | Never |
| `readmeproof list [README.md \| DIR]` | Lists every code block, its `file:line`, language, annotations | Never |
| `readmeproof verify [README.md \| DIR]` | Runs supported blocks in a container and checks assertions | Only inside Docker |

`check` and `list` work completely offline and never start Docker. `verify` is the only command that runs README
code, and it refuses to run it anywhere except in a container.

### Example `check` output

```text
README.md:5  FAIL       broken-link  file not found: docs/setup.md
    evidence: link target: docs/setup.md
    fix: Create the file or fix the path.
README.md:14  FAIL       package-script  package.json has no script named "lint"
    evidence: npm run lint
    fix: Add the script or use one of: build, test.

Static checks: 2 PASS, 2 FAIL, 0 SKIP, 1 UNVERIFIED
NOTHING VERIFIED: zero examples were executed. Run "readmeproof verify <README>" to run them in a Docker container.
Result: FAIL (exit code 1)
```

## What `check` looks at

| Rule | Status when it fails | Notes |
| --- | --- | --- |
| Relative links, images, HTML `src`/`href` | `FAIL` | Missing file, wrong letter case (works on Windows/macOS, breaks on Linux/GitHub) |
| Anchors (`#heading`, `file.md#heading`) | `FAIL` | GitHub heading slugs and explicit `<a name>` / `id` anchors |
| Path traversal and symlink escapes | `FAIL` | Links may not leave the repository; symlinks are resolved, never trusted |
| External `http(s)` links | `UNVERIFIED` | Never claimed broken: static checks do not use the network |
| `npm run x`, `npm test`, `yarn x`, `pnpm run x`, `bun run x` | `FAIL` | Script must exist in `package.json`. Skipped (`UNVERIFIED`) after `cd`, with `--workspace`/`--prefix`, or without a package.json |
| `node file.js`, `python x.py`, `./run.sh`, `bash x.sh` ... | `FAIL` | File must exist (and be executable for `./x` on POSIX). Build output such as `dist/` and files an earlier command creates are `UNVERIFIED`, not `FAIL` |
| `` `path/in/inline/code.md` `` | `UNVERIFIED` | Missing paths might be generated, so they are not failures |
| `npm install x`, `npx x`, `import ... from 'x'` | `FAIL` | Only when `package.json` proves the mistake: the name is a near miss of your package name (wrong scope, wrong case, typo) and is not a dependency or bin |
| Annotation syntax | `FAIL` | Typos, unknown keys, duplicate names, annotations on blocks that cannot run |

A run in which every finding is `PASS`/`SKIP`/`UNVERIFIED` exits `0`, but the output still says **NOTHING VERIFIED**:
static checks cannot show that an example works.

## Annotating examples

Put an HTML comment directly above a fenced code block. It is invisible in rendered Markdown.

````markdown
<!-- readmeproof: name=quickstart exit=0 output="hello from acme" -->
```sh
node scripts/hello.js
```

<!-- readmeproof: name=build exit=0 creates=out/result.txt -->
```bash
mkdir -p out
echo done > out/result.txt
```
````

| Key | Meaning |
| --- | --- |
| `name=<id>` | Name for `verify --block <id>`. Letters, digits, `.`, `_`, `-` |
| `exit=<0-255>` | Expected exit status (default expectation is `0`) |
| `output="text"` | stdout must **contain** the text |
| `output-exact="text"` | stdout must equal the text (trailing whitespace ignored) |
| `stderr="text"` | stderr must contain the text |
| `creates=a.txt,dir/b.txt` | These paths must not exist before the block and must exist after it |
| `timeout=<seconds>` | Per-block limit. Can lower the CLI `--timeout`, never raise it |
| `skip` | Never execute this block |

Quoted values support backslash-n, backslash-t, backslash-quote and double backslash. Malformed annotations are
reported by `check` as `FAIL`.

**Annotations can only assert and constrain.** There is deliberately no key to enable the network, choose an image,
mount anything or pass environment variables: a README is untrusted, so it cannot ask for more privileges.

### Smoke-tested vs. asserted

An executed block that exits `0` and has **no** declared assertions is a **smoke test**: it shows the command does not
crash, nothing more. A block whose declared assertions all held is **asserted**. The two are counted and reported
separately (`PASS (smoke)` / `PASS (asserted)`), and a run with only smoke passes says so.

## Execution (`verify`)

```console
$ readmeproof verify README.md                   # every executable block
$ readmeproof verify README.md --block quickstart
$ readmeproof verify . --image node:20-bookworm --timeout 30 --memory 512
```

Supported languages: `sh`, `bash` / `shell` (run with bash), `js` / `javascript` (run with Node; ES module syntax is
detected). Everything else is listed and skipped. `console`/transcript blocks with `$ ` prompts are not executed by
default; mark runnable ones as `sh` or `bash`.

Each block runs in its **own fresh container** with its **own fresh copy** of the project. State does not carry from one
block to the next, so a block must be self-contained (or you must assert on what it does by itself).

### Isolation model

Every run uses exactly these settings. None can be changed by the README:

| Control | Setting |
| --- | --- |
| Where it runs | Disposable `docker run --rm` container. **No host execution fallback.** |
| Network | `--network none` unless you pass `--network` |
| User / privileges | `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`; never `--privileged` |
| Filesystem | `--read-only` root; writable tmpfs only for `/work` (the project copy), `/tmp` and `/rp` |
| Host access | No bind mounts, no volumes, no Docker socket, no host home directory |
| Project copy | Streamed in as a tar over stdin. Excludes `.git`, `.env*` (except `.env.example`-style templates), SSH/PGP keys, `.npmrc`, `.netrc`, cloud credentials, `node_modules`, symlinks and special files; size and file-count capped |
| Environment | A fixed list (`HOME`, `CI`, `TERM`, ...). No host variable or credential is passed in |
| Resources | Memory (default 1024 MB, swap disabled), CPUs (1), PIDs (512), open files, per-block time limit (default 60 s, hard ceiling 900 s) |
| Output | Captured stdout/stderr are bounded (default 64 KiB each); runaway output kills the container |
| Cleanup | Container force-removed after every block, including on timeout |

If Docker is not installed, the daemon is not running, Windows containers are active, or the image is missing, the result
is `UNAVAILABLE` (exit code `3`) and nothing is executed.

The image (default `node:22-bookworm-slim`) must already exist locally. Pass `--pull` to let the Docker daemon pull it;
the pull is done by Docker, not by README code.

### Network opt-in

```console
$ readmeproof verify README.md --network
```

`--network` attaches the container to Docker's default bridge network. It is **off by default**, can only be enabled on
the command line, and the report prints `network ENABLED (--network)`. With it on, README code can reach everything the
Docker host can reach: the internet, your LAN, and cloud metadata endpoints. Use it only for READMEs you trust, ideally
on a throwaway machine. Failures that look network related get a hint to use `--network`.

### What a `PASS` means, and what it does not

A `PASS` means the README's own code, run in a clean sandbox, met its own assertions. It does **not** mean the code is
safe or the software is correct, and a malicious example can of course print whatever its assertions expect. Docker
containers share the host kernel, so they are not a perfect boundary against kernel or runtime exploits; for README
files from sources you do not trust at all, add rootless Docker, gVisor/Kata, or a disposable VM. See
[SECURITY.md](SECURITY.md) for the full threat model and limitations.

## Results and exit codes

| Status | Meaning |
| --- | --- |
| `PASS` | The check held (execution: `smoke` or `asserted`) |
| `FAIL` | Something is demonstrably wrong |
| `SKIP` | Intentionally not checked (marked `skip`, not executable, not a file link) |
| `UNVERIFIED` | Could not be determined (external links, generated files, Docker problems, truncated output) |

| Exit code | Meaning |
| --- | --- |
| `0` | OK. For `check` this still prints NOTHING VERIFIED |
| `1` | A `FAIL` was found |
| `2` | Usage or input error (bad flag, unknown block, README missing or too large) |
| `3` | `verify` could not use Docker: UNAVAILABLE |
| `4` | `verify` executed zero examples: NOTHING VERIFIED |
| `5` | `verify` ran examples but some could not be verified: INCOMPLETE |
| `70` | Internal error |

### JSON output

`--json` prints one JSON document to stdout (and nothing else). The shape is versioned (`schemaVersion: 1`) and key
order is fixed: `schemaVersion`, `tool`, `command`, `file`, `projectRoot`, `verdict`, `exitCode`, `summary`, `notices`,
`blocks`, then `findings` (check) or `execution` and `results` (verify).

```json
{
  "schemaVersion": 1,
  "tool": { "name": "@zuhairhalawa/readmeproof", "version": "0.1.0" },
  "command": "check",
  "file": "README.md",
  "verdict": "NOTHING_VERIFIED",
  "exitCode": 0,
  "summary": { "findings": { "PASS": 13, "FAIL": 0, "SKIP": 0, "UNVERIFIED": 3 }, "examplesExecuted": 0 }
}
```

`verdict` is one of `PASS`, `FAIL`, `NOTHING_VERIFIED`, `UNAVAILABLE`, `INCOMPLETE`, `LISTED`. `durationMs` values in
execution results vary between runs; everything else is deterministic.

## Options

```text
--json            JSON output          --root <dir>   project root (default: nearest .git or package.json)
--verbose         also show PASS/SKIP  --no-color     disable color (NO_COLOR is honoured)
verify only:
--block <name|line>   --image <image>   --pull   --network
--timeout <seconds>   --memory <MB>     --cpus <n>   --max-output <bytes>
```

Run `readmeproof --help` for the full text.

`--root` sets both the link boundary and the directory copied into containers. Point it at a clean checkout. The
copy is refused if it would be your home directory or a filesystem root.

## How it compares

- **[Runme](https://github.com/runmedev/runme)** turns README blocks into runnable notebook cells and runs them in your
  shell. It is built for convenient local execution; readmeproof is built for verification and never runs README code on
  the host.
- Markdown doctest-style tools generally evaluate code samples in-process. readmeproof adds static link/script/package
  checks and a container sandbox with declared assertions.
- Link checkers validate URLs over the network. readmeproof's static mode does not touch the network and reports external
  links as `UNVERIFIED`; use both.

## Limitations

- Secret exclusion for the container copy is based on file names and directories. A secret stored in an ordinarily named
  file (for example `config.json`) **is** copied into the (network-less) container. Use a clean checkout or `--root`.
- Only `sh`, `bash`/`shell` and `js` blocks run. Interactive programs, long-lived servers and blocks that depend on state
  from earlier blocks need to be restructured or marked `skip`.
- Static package-name checks only flag near-misses of your own `package.json` name; they cannot know whether another
  registry package exists.
- A remote `DOCKER_HOST` (for example over `tcp://`) means the sanitized project copy is sent to that daemon.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

