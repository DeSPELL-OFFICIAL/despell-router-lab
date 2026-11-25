import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Set<string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Set([...body.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe("theme tokens", () => {
  it("defines the same colour names in dark and light", () => {
    const dark = block('[data-theme="dark"]');
    const light = block('[data-theme="light"]');
    expect(dark.size).toBeGreaterThan(30);
    expect([...light].sort()).toEqual([...dark].sort());
  });
});
