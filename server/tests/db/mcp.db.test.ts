// MCP tool dispatch and token-scope checks against a throwaway database.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createToken } from "../../src/services/tokenService.js";
import mongoose from "mongoose";
import { hasDatabase, startHarness, type TestUser } from "./harness.js";

describe("MCP tools (HTTP, throwaway database)", { skip: hasDatabase ? false : "MONGODB_URI is not set" }, () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let owner: TestUser;

  before(async () => {
    h = await startHarness();
    owner = await h.makeUser("mcp-owner");
  });
  after(() => h?.stop());

  const mcp = async (token: string, name: string, args: unknown) => h.call(token, "POST", "/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  });

  it("creates projects, uploads icons, and reads detail, tags, and activity", async () => {
    const created = await mcp(owner.token, "create_project", { name: "MCP project", purpose: "font" });
    assert.equal(created.status, 200);
    const project = created.body.result.structuredContent;
    assert.equal(project.name, "MCP project");

    const added = await mcp(owner.token, "add_icon", { projectId: project.id, name: "Arrow", rawSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h10v10H1z"/></svg>', tags: ["navigation"] });
    assert.equal(added.body.result.structuredContent.outcome, "created");

    const detail = await mcp(owner.token, "get_project_detail", { projectId: project.id });
    assert.equal(detail.body.result.structuredContent.iconCount, 1);
    assert.equal(detail.body.result.structuredContent.uncategorizedCount, 1);

    const search = await mcp(owner.token, "search_icons_by_tag", { projectId: project.id, tag: "navigation" });
    assert.equal(search.body.result.structuredContent.total, 1);

    const log = await mcp(owner.token, "project_activity", { projectId: project.id });
    assert.ok(log.body.result.structuredContent.activities.length >= 2);
  });

  it("allows read tokens to use read tools and blocks project deletion", async () => {
    const project = await mcp(owner.token, "create_project", { name: "Read token project" });
    const projectId = project.body.result.structuredContent.id as string;
    const readToken = await createToken(new mongoose.Types.ObjectId(owner.id), "MCP read", { scope: "read", expiresInDays: null });

    const detail = await mcp(readToken.token, "get_project_detail", { projectId });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.result.structuredContent.id, projectId);

    const deletion = await mcp(readToken.token, "delete_project", { projectId });
    assert.equal(deletion.status, 403);
    assert.match(deletion.body.error, /read-only/);
    assert.match(deletion.body.error, /read\/write API token/);
  });
});
