import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsListResult } from "../src/routes/mcpRoutes.js";

describe("MCP tools/list", () => {
  it("includes cache hints for modern protocol clients", () => {
    const result = createToolsListResult(true);

    assert.equal(result.resultType, "complete");
    assert.equal(result.ttlMs, 300_000);
    assert.equal(result.cacheScope, "public");
    assert.ok(Array.isArray(result.tools));
  });

  it("does not add modern cache hints to legacy responses", () => {
    const result = createToolsListResult(false);

    assert.equal("ttlMs" in result, false);
    assert.equal("cacheScope" in result, false);
    assert.ok(Array.isArray(result.tools));
  });
});
