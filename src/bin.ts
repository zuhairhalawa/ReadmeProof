#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  cwd: process.cwd(),
  env: process.env,
  stdoutIsTTY: process.stdout.isTTY === true,
});
process.exitCode = code;

