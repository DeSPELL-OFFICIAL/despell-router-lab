import assert from "node:assert/strict";
import { test } from "node:test";
import { scanText } from "./check-secrets.mjs";

// Fixtures are assembled at run time so this file itself never matches a rule.
const hex64 = "ab".repeat(32);
const rules = (path, text) => scanText(path, text).map((f) => f.rule);

test("flags a private key but not a transaction hash", () => {
  assert.deepEqual(rules("a.ts", `const PRIVATE_KEY = "0x${hex64}";`), ["hex private key"]);
  assert.deepEqual(rules("README.md", `Loop tx: 0x${hex64}`), []);
});

test("flags common token shapes", () => {
  assert.deepEqual(rules("a.ts", "k = " + "sk-" + "a".repeat(30)), ["OpenAI-style key"]);
  assert.deepEqual(rules("a.ts", "ghp_" + "A".repeat(36)), ["GitHub token"]);
  assert.deepEqual(rules("a.ts", "https://base-sepolia.g.alchemy.com/v2/" + "x".repeat(32)), ["RPC URL with key"]);
  assert.deepEqual(rules("a.ts", "postgres://reader:" + "hunter2" + "@db.example/journal"), ["database URL with password"]);
  assert.deepEqual(rules("a.ts", `cmcApiKey: "${"Q".repeat(24)}"`), ["assigned API key"]);
});

test("env files: only an example with empty values", () => {
  assert.deepEqual(rules(".env", "A=1"), ["env file in git"]);
  assert.deepEqual(rules("app/.env.local", ""), ["env file in git"]);
  assert.deepEqual(rules(".env.example", "# comment\nCMC_API_KEY=\nRPC_URL=\n"), []);
  assert.deepEqual(rules(".env.example", "CMC_API_KEY=abc"), ["value in env example"]);
});

test("allow marker and key files", () => {
  assert.deepEqual(rules("a.ts", `const PRIVATE_KEY = "0x${hex64}"; // secret-scan: allow`), []);
  assert.deepEqual(rules("deploy.pem", "anything"), ["key file in git"]);
});
