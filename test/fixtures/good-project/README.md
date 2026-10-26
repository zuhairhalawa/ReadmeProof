# Acme CLI

![Acme logo](assets/logo.png)

[![npm version](https://img.shields.io/npm/v/acme-cli.svg)](https://www.npmjs.com/package/acme-cli)

A tiny example tool used as a realistic fixture.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Guide](docs/guide.md#getting-started)
- [Changelog][changelog]

## Install

```sh
npm install -g acme-cli
```

Or run it without installing:

```sh
npx acme --help
```

## Quick start

Run the bundled hello script:

<!-- readmeproof: name=quickstart exit=0 output="hello from acme" -->
```sh
node scripts/hello.js
```

Create the output file:

<!-- readmeproof: name=makefile exit=0 creates=out/result.txt -->
```bash
mkdir -p out
echo done > out/result.txt
```

A plain smoke example with no assertions:

```sh
node scripts/hello.js > /dev/null
```

Expected output looks like this (not executed):

```text
hello from acme
```

<a name="configuration"></a>
## Configuration

See [the guide](docs/guide.md) and the [config section](#configuration).

Run the test suite with `npm test`, or build with `npm run build`.
Project files: `package.json`, `scripts/hello.js`.

[changelog]: https://example.com/acme/changelog

