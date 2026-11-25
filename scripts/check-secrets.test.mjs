import assert from "node:assert/strict";
import { test } from "node:test";
import { scanText } from "./check-secrets.mjs";

// Fixtures are assembled at run time so this file itself never matches a rule.
const hex64 = "ab".repeat(32);
const addr = "0x" + "c0ffee".repeat(6) + "beef";
const rnd = "Qz7" + "k2Pq9".repeat(5); // 28 chars, letters and digits
const words = (n) => Array.from({ length: n }, (_, i) => ["abandon", "ability", "able", "about"][i % 4]).join(" ");
const rules = (path, text) => scanText(path, text).map((f) => f.rule);

test("flags a private key but not a transaction hash", () => {
  assert.ok(rules("a.ts", `const PRIVATE_KEY = "0x${hex64}";`).includes("hex private key"));
  assert.deepEqual(rules("README.md", `Loop tx: 0x${hex64}`), []);
  assert.ok(rules("deploy.ts", `const account = privateKeyToAccount("0x${hex64}");`).includes("hex private key"));
  assert.ok(rules("deploy.ts", `const w = new Wallet("0x${hex64}");`).includes("hex private key"));
  assert.ok(rules("deploy.ts", `deployerKey: "0x${hex64}",`).includes("hex private key"));
});

test("flags common token shapes", () => {
  assert.deepEqual(rules("a.ts", "k = " + "sk-" + "a".repeat(30)), ["OpenAI-style key"]);
  assert.deepEqual(rules("a.ts", "ghp_" + "A".repeat(36)), ["GitHub token"]);
  assert.deepEqual(rules("a.ts", "https://base-sepolia.g.alchemy.com/v2/" + "x".repeat(32)), ["RPC URL with key"]);
  assert.deepEqual(rules("a.ts", "postgres://reader:" + "hunter2" + "@db.example/journal"), ["database URL with password"]);
  assert.deepEqual(rules("a.ts", `cmcApiKey: "${rnd}"`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `CMC_API_KEY_V2: "${rnd}"`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `const supabaseKey = "${"eyJ" + "a1".repeat(6) + "." + "b2".repeat(6)}";`), ["assigned API key"]);
});

test("unquoted values: shell, yaml, headers, query strings, Bearer", () => {
  assert.deepEqual(rules("deploy.sh", `export CMC_API_KEY=${rnd}`), ["assigned API key"]);
  assert.deepEqual(rules("ci.yml", `  api_key: ${rnd}`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `curl -H 'X-CMC_PRO_API_KEY: ${rnd}'`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `fetch("https://api.example.com/v1/q?symbol=NVDA&key=${rnd}")`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `Authorization: Bearer ${rnd}`), ["assigned API key"]);
});

test("public values and lookups are not secrets", () => {
  assert.deepEqual(rules("a.ts", `const USDC_TOKEN_ADDRESS = "${addr}";`), []);
  assert.deepEqual(rules("a.ts", `tokenAddress: ${addr},`), []);
  assert.deepEqual(rules("a.ts", `const apiKey = process.env.CMC_API_KEY;`), []);
  assert.deepEqual(rules("ci.yml", "  CMC_API_KEY: ${{ secrets.CMC_API_KEY }}"), []);
  assert.deepEqual(rules("a.ts", `headers: { "X-CMC_PRO_API_KEY": key }`), []);
  assert.deepEqual(rules("a.ts", `Authorization: \`Bearer \${token}\``), []);
  assert.deepEqual(rules("a.ts", `apiKey: string;`), []);
});

test("64 hex: hashes and pool ids pass, a key on the line above is caught", () => {
  assert.deepEqual(rules("a.ts", `const POOL_KEY_HASH = "0x${hex64}";`), []);
  assert.deepEqual(rules("a.ts", `poolId: "0x${hex64}", txHash: "0x${hex64}"`), []);
  assert.deepEqual(rules("README.md", `| fee change | 0x${hex64} |`), []);
  assert.deepEqual(rules("a.ts", `const deployer =\n  "0x${hex64}";`), []);
  assert.deepEqual(rules("a.ts", `const signerKey =\n  "0x${hex64}";`), ["hex private key"]);
});

test("seed phrases", () => {
  assert.deepEqual(rules("a.ts", `const words = "${words(12)}";`), ["seed phrase"]);
  assert.deepEqual(rules("a.ts", `mnemonic: '${words(24)}'`), ["seed phrase"]);
  assert.deepEqual(rules("a.ts", `const s = "${words(11)}";`), []);
});

test("env files: only an example with empty values", () => {
  assert.deepEqual(rules(".env", "A=1"), ["env file in git"]);
  assert.deepEqual(rules("app/.env.local", ""), ["env file in git"]);
  assert.deepEqual(rules(".env.example", "# comment\nCMC_API_KEY=\nRPC_URL=\n"), []);
  assert.deepEqual(rules(".env.example", "CMC_API_KEY=abc"), ["value in env example"]);
  assert.deepEqual(rules(".env.example", "export JOURNAL_DATABASE_URL=" + "postgres://r:" + "p@h/db"), ["value in env example"]);
  assert.deepEqual(rules(".env.example", "rpc_url=https://x"), ["value in env example"]);
  assert.deepEqual(rules(".env.example", "not an assignment"), ["value in env example"]);
});

test("allow marker and key files", () => {
  assert.deepEqual(rules("a.ts", `const PRIVATE_KEY = "0x${hex64}"; // secret-scan: allow`), []);
  assert.deepEqual(rules("deploy.pem", "anything"), ["key file in git"]);
});

test("names that only contain a public word still count as keys", () => {
  for (const line of [
    `const BLOCKCHAIN_PRIVATE_KEY = "0x${hex64}";`,
    `ROOT_KEY=0x${hex64}`,
    `const rootSignerKey = "0x${hex64}";`,
    `commitWalletKey: "0x${hex64}",`,
    `DEPLOYER_PK=0x${hex64}`,
  ]) {
    assert.ok(rules("deploy.ts", line).includes("hex private key"), line);
  }
});

test("64-hex values under a secret name, in a Bearer header or a token query", () => {
  const hex = "3f9a".repeat(16);
  assert.deepEqual(rules("a.ts", `const authToken = "${hex}";`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `password: "${hex}"`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `Authorization: Bearer ${hex}`), ["assigned API key"]);
  assert.deepEqual(rules("a.ts", `fetch("https://api.example.com/feed?token=${hex}")`), ["assigned API key"]);
});

test("explorer links, URLs and the word seed are not secrets", () => {
  const tx = "0x" + "eda4ebee75".repeat(6) + "8c2a";
  assert.deepEqual(rules("reactive/README.md", `| Seed 0.01 ETH (position 34377) | [\`0xeda4…8c2a\`](https://sepolia.basescan.org/tx/${tx}) | 63531666 |`), []);
  assert.deepEqual(rules("a.ts", `account deployed in https://sepolia.basescan.org/tx/${tx}`), []);
  assert.deepEqual(rules("a.ts", `const CMC_TOKEN_INFO_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/info";`), []);
  assert.deepEqual(rules("a.ts", `const authorName = "${rnd}";`), []);
});

