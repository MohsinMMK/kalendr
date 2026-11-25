#!/usr/bin/env node
import { run } from "../src/cli.mjs";

process.exitCode = await run(process.argv.slice(2), { env: process.env, fetch: globalThis.fetch, out: (line) => console.log(line), err: (line) => console.error(line) });
