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
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW = "secret-scan: allow";

/* 64 hex digits is a private key or a transaction hash. Flag it only when the line says key, secret, seed or mnemonic. */
const KEYISH = /(priv(ate)?[_ -]?key|secret|mnemonic|seed|signer[_ -]?key|_KEY\b|\bpk\b)/i;
const HEX64 = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

const RULES = [
  { name: "private key block", test: (l) => /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/.test(l) },
  { name: "hex private key", test: (l) => HEX64.test(l) && KEYISH.test(l) },
  { name: "OpenAI-style key", test: (l) => /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/.test(l) },
  { name: "GitHub token", test: (l) => /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/.test(l) },
  { name: "AWS access key", test: (l) => /\bAKIA[0-9A-Z]{16}\b/.test(l) },
  { name: "Slack token", test: (l) => /\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(l) },
  { name: "Google API key", test: (l) => /\bAIza[0-9A-Za-z_-]{35}\b/.test(l) },
  { name: "RPC URL with key", test: (l) => /(alchemy\.com\/v2\/|infura\.io\/v3\/|quiknode\.pro\/|drpc\.org\/[^\s"']*dkey=)[A-Za-z0-9_-]{16,}/.test(l) },
  { name: "database URL with password", test: (l) => /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:/@"']+:[^\s@"']+@/.test(l) },
  { name: "assigned API key", test: (l) => /\b[A-Za-z_]*(api[_-]?key|secret|token|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{20,}["']/i.test(l) },
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
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[2].trim() !== "" && !line.includes(ALLOW)) findings.push({ path, line: i + 1, rule: "value in env example" });
    });
    return findings;
  }
  if (KEY_FILE.test(name)) return [{ path, line: 0, rule: "key file in git" }];
  text.split("\n").forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    for (const rule of RULES) {
      if (rule.test(line)) findings.push({ path, line: i + 1, rule: rule.name });
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
  const cwd = process.cwd();
  const findings = [];
  let scanned = 0;
  for (const path of filesToScan(cwd)) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const buf = readFileSync(path);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
