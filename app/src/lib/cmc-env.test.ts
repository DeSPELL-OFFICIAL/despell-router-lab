import { afterEach, describe, expect, it, vi } from "vitest";
import { despellConnectorTarget } from "./cmc-env";

afterEach(() => vi.unstubAllEnvs());

describe("despellConnectorTarget", () => {
  it("defaults to the production app", () => {
    vi.stubEnv("DESPELL_MCP_URL", "");
    expect(despellConnectorTarget()).toEqual({ ok: true, url: "https://app.despell.io/api/mcp", host: "app.despell.io", production: true });
  });

  it("uses DESPELL_MCP_URL and says when it is not production", () => {
    vi.stubEnv("DESPELL_MCP_URL", "https://test.despell.io/api/mcp");
    expect(despellConnectorTarget()).toMatchObject({ ok: true, host: "test.despell.io", production: false });
  });

  it("reports a malformed value instead of falling back to production", () => {
    for (const bad of ["test.despell.io/api/mcp", "http://test.despell.io/api/mcp"]) {
      vi.stubEnv("DESPELL_MCP_URL", bad);
      expect(despellConnectorTarget().ok).toBe(false);
    }
  });
});
