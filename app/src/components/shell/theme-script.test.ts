import { describe, expect, it } from "vitest";
import { themeScript } from "./theme-script";

type Env = { stored?: string | null; storageThrows?: boolean; prefersLight: boolean };

function run(env: Env): string | null {
  let theme: string | null = null;
  const localStorage = {
    getItem: () => {
      if (env.storageThrows) throw new Error("SecurityError");
      return env.stored ?? null;
    },
  };
  const window = { matchMedia: () => ({ matches: env.prefersLight }) };
  const document = { documentElement: { setAttribute: (_: string, v: string) => (theme = v) } };
  new Function("localStorage", "window", "document", themeScript)(localStorage, window, document);
  return theme;
}

describe("theme script", () => {
  it("uses the saved theme first", () => {
    expect(run({ stored: "light", prefersLight: false })).toBe("light");
    expect(run({ stored: "dark", prefersLight: true })).toBe("dark");
  });

  it("falls back to the system preference, even when storage throws", () => {
    expect(run({ stored: null, prefersLight: true })).toBe("light");
    expect(run({ storageThrows: true, prefersLight: true })).toBe("light");
    expect(run({ storageThrows: true, prefersLight: false })).toBe("dark");
  });
});
