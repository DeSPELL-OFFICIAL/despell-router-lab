#!/usr/bin/env node
/*
  Fails when a file that git would commit looks like it holds a secret.

  This repository is public, so keys, RPC keys, seed phrases and database URLs
  live only in Vercel environment variables or env files outside git. The scan
  covers tracked files plus new files that are not ignored, so it catches a
  secret before the first commit too.

  A line can opt out with the marker "secret-scan: allow" when it holds a
  public value that only looks like a secret (say, a known test vector).
*/
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW = "secret-scan: allow";

/*
  64 hex digits is either a private key or a public 32-byte value (a tx hash,
  pool id, salt, topic). A line is flagged when it, or the line just above a
  bare value, speaks of a key, wallet, account, signer, seed or secret. Names
  of public 32-byte values (POOL_KEY_HASH, txHash, poolId...) are blanked out
  first so they don't count as "key".
*/
const HEX64 = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const BARE_HEX64 = /^\s*["'`]?(0x)?[0-9a-fA-F]{64}["'`]?\s*[,;)]?\s*$/;
const PUBLIC32_NAME = /[A-Za-z0-9_]*(hash|keccak|txid|tx_?id|pool_?id|salt|root|topic|selector|digest|commit|block)[A-Za-z0-9_]*/gi;
const KEYISH = /(key|secret|mnemonic|seed|signer|wallet|account|\bpk\b|fromPrivate|privateKeyTo)/i;
const keyish = (line) => KEYISH.test(line.replace(PUBLIC32_NAME, " "));

/*
  A value assigned to a secret-sounding name, quoted or not: JS/TS, YAML,
  shell (export X=...), HTTP headers (X-CMC_PRO_API_KEY: ...), query strings
  and Bearer tokens. Addresses (0x + 40 hex) are public and never count;
  64-hex values are left to the rule above. A value must look random enough:
  20+ characters with both letters and digits, and not an env lookup.
*/
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:[A-Za-z][_-]?key|secret|token|password|passwd)[A-Za-z0-9_-]*`;
const ASSIGNED = new RegExp(String.raw`(?:^|[^A-Za-z0-9_-])${SECRET_NAME}["']?\s*(?::|=>|=)\s*["'\`]?([^\s"'\`,;()]+)`, "gi");
const QUERY = /[?&](?:key|api_?key|apikey|token|access_token|auth)=([^&\s"'`#]+)/gi;
const BEARER = /\bBearer\s+([A-Za-z0-9_\-.=+/]+)/g;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LOOKUP = /^(\$|process\.env|import\.meta|env\.|<|\{\{|your|xxx|changeme|example|placeholder)/i;

export function looksSecret(value) {
  if (value.length < 20 || ADDRESS.test(value) || /^(0x)?[0-9a-fA-F]{64}$/.test(value) || LOOKUP.test(value)) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}
const anyMatch = (re, line) => [...line.matchAll(re)].some((m) => looksSecret(m[1]));

/* A quoted run of 12, 15, 18, 21 or 24 BIP-39-shaped words (3 to 8 lowercase letters). */
const SEED_WORDS = /["'`]((?:[a-z]{3,8}\s+){11,23}[a-z]{3,8})["'`]/;
const seedPhrase = (line) => {
  const m = SEED_WORDS.exec(line);
  return !!m && [12, 15, 18, 21, 24].includes(m[1].trim().split(/\s+/).length);
};

const RULES = [
  { name: "private key block", test: (l) => /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/.test(l) },
  { name: "hex private key", test: (l, prev) => HEX64.test(l) && (keyish(l) || (BARE_HEX64.test(l) && keyish(prev))) },
  { name: "seed phrase", test: (l) => seedPhrase(l) },
  { name: "OpenAI-style key", test: (l) => /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/.test(l) },
  { name: "GitHub token", test: (l) => /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/.test(l) },
  { name: "AWS access key", test: (l) => /\bAKIA[0-9A-Z]{16}\b/.test(l) },
  { name: "Slack token", test: (l) => /\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(l) },
  { name: "Google API key", test: (l) => /\bAIza[0-9A-Za-z_-]{35}\b/.test(l) },
  { name: "RPC URL with key", test: (l) => /(alchemy\.com\/v2\/|infura\.io\/v3\/|quiknode\.pro\/|drpc\.org\/[^\s"']*dkey=)[A-Za-z0-9_-]{16,}/.test(l) },
  { name: "database URL with password", test: (l) => /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:/@"']+:[^\s@"']+@/.test(l) },
  { name: "assigned API key", test: (l) => anyMatch(ASSIGNED, l) || anyMatch(QUERY, l) || anyMatch(BEARER, l) },
];

/* Env files: only the example file may be committed, and only with empty values. */
const ENV_FILE = /^\.env(\..+)?$/;
const KEY_FILE = /\.(pem|key|p12|pfx|keystore)$/i;

export function scanText(path, text) {
  const findings = [];
  const name = basename(path);
  if (ENV_FILE.test(name)) {
    if (name !== ".env.example") {
      findings.push({ path, line: 0, rule: "env file in git" });
      return findings;
    }
    text.split("\n").forEach((line, i) => {
      if (line.includes(ALLOW) || /^\s*(#|$)/.test(line)) return;
      const m = /^\s*(export\s+)?([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(line);
      if (!m || m[3].trim() !== "") findings.push({ path, line: i + 1, rule: "value in env example" });
    });
    return findings;
  }
  if (KEY_FILE.test(name)) return [{ path, line: 0, rule: "key file in git" }];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    const prev = i > 0 ? lines[i - 1] : "";
    for (const rule of RULES) {
      if (rule.test(line, prev)) findings.push({ path, line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

const SKIP = [/^pnpm-lock\.yaml$/, /(^|\/)node_modules\//];
const MAX_BYTES = 2_000_000;

function filesToScan(cwd) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  return out.split("\0").filter((p) => p && !SKIP.some((re) => re.test(p)));
}

function main() {
  // Scan the whole repository whichever folder this runs from.
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const findings = [];
  let scanned = 0;
  for (const path of filesToScan(cwd)) {
    let stat;
    try {
      stat = statSync(join(cwd, path));
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const buf = readFileSync(join(cwd, path));
    if (buf.includes(0)) continue; // binary
    scanned += 1;
    findings.push(...scanText(path, buf.toString("utf8")));
  }
  if (findings.length) {
    for (const f of findings) console.error(`${f.path}${f.line ? `:${f.line}` : ""}  ${f.rule}`);
    console.error(`\ncheck-secrets: ${findings.length} possible secret(s). Move the value to an env variable, or mark a public value with "${ALLOW}".`);
    process.exit(1);
  }
  console.log(`check-secrets: ${scanned} files clean`);
}

/* Run only as a script, also when either path goes through a symlink. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
