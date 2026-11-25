#!/usr/bin/env node
// Runs one command with the deployer key in PRIVATE_KEY and keeps the key out of its output.
//
//   node --env-file=<your env file> scripts/with-key.mjs [--from NAME] -- forge script ...
//
// The key is read from the environment variable NAME (default PRIVATE_KEY), removed from this
// process, and handed to the child as PRIVATE_KEY. The forge scripts read it with vm.envUint.
// Every line the child prints is scrubbed of the key (hex and decimal forms) before it is shown,
// so a verbose trace cannot leak it. The key is never written to disk or passed as an argument.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
let from = "PRIVATE_KEY";
if (args[0] === "--from") {
  from = args[1];
  args.splice(0, 2);
}
if (args[0] === "--") args.shift();

const raw = process.env[from];
delete process.env[from];
if (!raw) {
  console.error(`with-key: ${from} is not set`);
  process.exit(2);
}
if (args.length === 0) {
  console.error("with-key: no command given");
  process.exit(2);
}

const hex = raw.trim().replace(/^0x/i, "").toLowerCase();
if (!/^[0-9a-f]{64}$/.test(hex)) {
  console.error(`with-key: ${from} is not a 32-byte hex key`);
  process.exit(2);
}
const hexPattern = new RegExp(hex, "gi");
const decimal = BigInt(`0x${hex}`).toString(10);
const scrub = (line) => line.replace(hexPattern, "[redacted]").split(decimal).join("[redacted]");

const child = spawn(args[0], args.slice(1), {
  env: { ...process.env, PRIVATE_KEY: `0x${hex}` },
  stdio: ["inherit", "pipe", "pipe"],
});
const relay = (stream, sink) =>
  new Promise((resolve) => {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => sink.write(`${scrub(line)}\n`));
    lines.on("close", resolve);
  });
const relayed = Promise.all([relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)]);
const exited = new Promise((resolve) => {
  child.on("error", (err) => {
    console.error(`with-key: ${err.message}`);
    resolve(1);
  });
  child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});
const [code] = await Promise.all([exited, relayed]);
process.exit(code);
