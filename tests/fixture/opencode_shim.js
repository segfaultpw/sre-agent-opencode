#!/usr/bin/env node
// The opencode binary the runner finds on PATH in the test suites. The bash
// stub cannot record the PWD the runner handed over, because bash resets a
// PWD that does not match its working directory before any script line runs,
// and opencode resolves a run's project from that variable before the working
// directory. Node passes its environment through untouched, so this process,
// the first of the spawn, is the one that can see it: it records the value
// and hands everything to the bash stub.
"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

if (process.env.STUB_OPENCODE_LOG) {
  fs.appendFileSync(process.env.STUB_OPENCODE_LOG, `inherited_pwd: ${process.env.PWD || ""}\n`);
}

const stub = process.env.STUB_OPENCODE_BIN;
if (!stub) {
  process.stderr.write("opencode_shim: STUB_OPENCODE_BIN is not set\n");
  process.exit(99);
}
// The bash stub's parent is this shim, which runs as the agent's own
// account, so a probe that walks to the parent would read this process's
// environment and find it readable. The process that must stay unreadable is
// the runner that spawned this shim, so its pid travels with the stub.
const result = spawnSync("bash", [stub, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, STUB_RUNNER_PID: String(process.ppid) },
});
process.exit(result.status === null ? 1 : result.status);
