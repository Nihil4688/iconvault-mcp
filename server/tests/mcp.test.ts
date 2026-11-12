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

  it("advertises all requested project, icon, history, import, and build tools", () => {
    const tools = createToolsListResult(false).tools;
    const names = new Set<string>(tools.map((tool) => tool.name));
    assert.equal(names.size, tools.length, "tool names must be unique");
    for (const name of [
      "get_project_fonticon", "get_project_detail", "list_project_versions", "get_icon_versions", "export_project",
      "list_font_builds", "get_font_build_zip", "list_sprite_builds", "get_sprite_build_zip", "search_icons_by_tag",
      "search_icons_by_folder", "project_activity", "audit_log", "create_project", "update_project", "delete_project",
      "duplicate_project", "import_project", "import_project_export", "upload_icons", "import_font_glyphs", "update_icon",
      "delete_icon", "move_icon_to_trash", "restore_icon", "batch_delete_icons", "batch_move_icons", "batch_tag_icons",
      "optimize_icon", "batch_optimize_icons", "empty_trash", "build_font", "build_project_sprite", "copy_icons",
    ]) assert.ok(names.has(name), `missing MCP tool ${name}`);
  });

  it("marks mutating tools with appropriate annotations", () => {
    const tools = new Map(createToolsListResult(false).tools.map((tool) => [tool.name, tool]));
    assert.equal(tools.get("get_project_detail")?.annotations.readOnlyHint, true);
    assert.equal(tools.get("delete_project")?.annotations.destructiveHint, true);
    assert.equal(tools.get("empty_trash")?.annotations.destructiveHint, true);
    assert.equal(tools.get("create_project")?.annotations.readOnlyHint, false);
    assert.equal(tools.get("build_font")?.annotations.readOnlyHint, false);
  });
});
