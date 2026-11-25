import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTESTS, getContest } from "./contests";

const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

describe("contests", () => {
  it("lists the four hackathons once each", () => {
    expect(CONTESTS.map((c) => c.slug)).toEqual(["reactive", "xlayer", "ethglobal", "cmc"]);
    expect(new Set(CONTESTS.map((c) => c.folder)).size).toBe(CONTESTS.length);
  });

  it("matches the README folder table", () => {
    for (const c of CONTESTS) {
      expect(readme).toContain(`| \`${c.folder}\` | ${c.hackathon} |`);
      expect(readme).toContain(c.pitch);
    }
  });

  it("throws on an unknown slug", () => {
    expect(() => getContest("nope" as never)).toThrow(/Unknown contest/);
  });
});
