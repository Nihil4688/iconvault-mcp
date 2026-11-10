// Stateless Streamable HTTP MCP endpoint. Every request is authenticated with
// the same personal API token used by the REST API.
import { Router, type Request } from "express";
import { z } from "zod";
import { actorOf, loadProject, parseObjectId } from "../lib/http.js";
import { listProjects } from "../services/projectService.js";
import { listIcons, searchIcons } from "../services/iconService.js";
import { buildProjectSprite } from "../services/spriteService.js";
import Icon from "../models/Icon.js";
import { requireDb } from "../middleware/requireDb.js";
import { requireUser } from "../middleware/requireUser.js";
import { heavyLimit } from "../middleware/rateLimit.js";
import { listProjectsQuerySchema } from "../lib/validation.js";
import { toHttpError } from "../lib/errors.js";

const router = Router();
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_PROTOCOLS = [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS];
const PROJECT_TOOLS = [
  { name: "list_projects", description: "List IconVault projects visible to the authenticated user.", inputSchema: { type: "object", properties: { search: { type: "string", maxLength: 100 }, scope: { type: "string", enum: ["all", "mine", "public"] }, purpose: { type: "string", enum: ["all", "sprite", "font"] }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
  { name: "search_icons", description: "Search active icons in projects visible to the authenticated user.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"] } },
  { name: "list_project_icons", description: "List icons in a project the user can view, optionally filtered by name, folder, or tag.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, search: { type: "string", maxLength: 100 }, folderId: { type: "string", description: "Folder id, or 'root' for uncategorized icons." }, tag: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 100 }, includeSvg: { type: "boolean" } }, required: ["projectId"] } },
  { name: "get_icon", description: "Get an icon's metadata and sanitized SVG markup, if its project is visible to the user.", inputSchema: { type: "object", properties: { iconId: { type: "string" } }, required: ["iconId"] } },
  { name: "get_project_sprite", description: "Build and return the SVG sprite for a project the user can view.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, folderId: { type: "string", description: "Optional folder id, or 'root' for uncategorized icons." } }, required: ["projectId"] } },
];

const optionalString = z.string().trim().max(100).optional();
const toolArgs = z.record(z.string(), z.unknown());
function result(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
function errorResult(error: unknown) {
  return { isError: true, content: [{ type: "text", text: toHttpError(error).body.error }] };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function protocolMeta(body: { params?: unknown }) {
  const params = body.params as { _meta?: Record<string, unknown> } | undefined;
  return params?._meta;
}
function isModern(meta: Record<string, unknown> | undefined) {
  return meta?.["io.modelcontextprotocol/protocolVersion"] === MODERN_PROTOCOL;
}
function originAllowed(origin: string | undefined) {
  if (!origin) return true;
  const allowed = (process.env.CORS_ORIGINS ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);
  return allowed.includes(origin.replace(/\/+$/, ""));
}

async function callTool(req: Request, name: string, rawArgs: unknown) {
  const args = toolArgs.parse(rawArgs ?? {});
  const actor = actorOf(req);
  switch (name) {
    case "list_projects": {
      const input = z.object({ search: optionalString, scope: z.enum(["all", "mine", "public"]).optional(), purpose: z.enum(["all", "sprite", "font"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      const query = listProjectsQuerySchema.parse({ search: input.search, scope: input.scope, purpose: input.purpose, limit: input.limit ?? 50 });
      const listed = await listProjects(actor, query);
      return result({ ...listed, projects: listed.projects.map(({ sampleIcons: _samples, ...project }) => project) });
    }
    case "search_icons": {
      const input = z.object({ query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      return result(await searchIcons(actor, input.query, 1, input.limit ?? 50));
    }
    case "list_project_icons": {
      const input = z.object({ projectId: z.string().min(1).max(100), search: optionalString, folderId: z.string().max(100).optional(), tag: z.string().trim().max(40).optional(), limit: z.number().int().min(1).max(100).optional(), includeSvg: z.boolean().optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const folder = input.folderId === undefined ? "all" : input.folderId === "root" ? "root" : parseObjectId(input.folderId, "folder id");
      const limit = input.includeSvg ? Math.min(input.limit ?? 50, 3) : input.limit ?? 50;
      return result(await listIcons(project._id, { folder, includeSubfolders: false, search: input.search, tag: input.tag, trash: false, sort: "name", page: 1, limit, withSvg: input.includeSvg ?? false }));
    }
    case "get_icon": {
      const { iconId } = z.object({ iconId: z.string().min(1).max(100) }).strict().parse(args);
      const icon = await Icon.findById(parseObjectId(iconId, "icon id"));
      if (!icon || icon.deletedAt) throw new Error("Icon not found.");
      await loadProject(actor, icon.projectId, "view");
      return result({ id: String(icon._id), projectId: String(icon.projectId), name: icon.name, slug: icon.slug, tags: icon.tags, viewBox: icon.viewBox, width: icon.width, height: icon.height, svg: icon.svg });
    }
    case "get_project_sprite": {
      const input = z.object({ projectId: z.string().min(1).max(100), folderId: z.string().max(100).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const folder = input.folderId === undefined ? null : input.folderId === "root" ? "root" : parseObjectId(input.folderId, "folder id");
      const sprite = await buildProjectSprite(project._id, project.prefix ?? "icon", folder);
      return { content: [{ type: "text", text: sprite.xml }], structuredContent: { iconCount: sprite.ids.length, svg: sprite.xml } };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

router.use((req, res, next) => {
  if (!originAllowed(req.header("origin"))) {
    res.status(403).json({ error: "Origin is not allowed for MCP. Configure CORS_ORIGINS with this exact site origin." });
    return;
  }
  next();
});
router.get("/", (_req, res) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "MCP endpoint accepts POST requests only." });
});
router.use(requireDb, requireUser);
router.use((req, res, next) => {
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  if (body?.method === "tools/call" && body.params?.name === "get_project_sprite") {
    heavyLimit(req, res, next);
    return;
  }
  next();
});
router.post("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json(rpcError(body?.id, -32600, "Invalid JSON-RPC request."));
    return;
  }
  const id = body.id;
  const meta = protocolMeta(body);
  const requestedVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const modern = isModern(meta);
  if (modern) {
    const headerVersion = req.header("mcp-protocol-version");
    const headerMethod = req.header("mcp-method");
    const params = body.params as { name?: unknown } | undefined;
    const headerName = req.header("mcp-name");
    if (headerVersion !== MODERN_PROTOCOL || headerMethod !== body.method || (body.method === "tools/call" && headerName !== params?.name)) {
      res.status(400).json(rpcError(id, -32020, "MCP request headers do not match the JSON-RPC body."));
      return;
    }
  }
  if (requestedVersion !== undefined && (typeof requestedVersion !== "string" || !SUPPORTED_PROTOCOLS.includes(requestedVersion))) {
    res.status(400).json({ ...rpcError(id, -32022, "Unsupported protocol version."), error: { code: -32022, message: "Unsupported protocol version.", data: { supported: SUPPORTED_PROTOCOLS, requested: requestedVersion } } });
    return;
  }
  if (modern && (!meta?.["io.modelcontextprotocol/clientInfo"] || !("io.modelcontextprotocol/clientCapabilities" in (meta ?? {})))) {
    res.status(400).json(rpcError(id, -32602, "Modern MCP requests must include clientInfo and clientCapabilities metadata."));
    return;
  }
  if (body.method.startsWith("notifications/")) {
    res.status(202).end();
    return;
  }
  if (body.method === "server/discover" && modern) {
    res.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: SUPPORTED_PROTOCOLS, capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "iconvault", version: "1.0.0" } }, instructions: "Read-only access to projects and icons available to the authenticated IconVault user." } });
    return;
  }
  if (body.method === "initialize") {
    const params = body.params as { protocolVersion?: unknown } | undefined;
    const version = typeof params?.protocolVersion === "string" && LEGACY_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_PROTOCOLS[0];
    res.json({ jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "iconvault", version: "1.0.0" } } });
    return;
  }
  if (body.method === "ping") {
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (body.method === "tools/list") {
    const tools = PROJECT_TOOLS.map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
    res.json({ jsonrpc: "2.0", id, result: { ...(modern ? { resultType: "complete" } : {}), tools } });
    return;
  }
  if (body.method === "tools/call") {
    const params = body.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string") {
      res.json(rpcError(id, -32602, "Tool name is required."));
      return;
    }
    try {
      const toolResult = await callTool(req, params.name, params.arguments);
      res.json({ jsonrpc: "2.0", id, result: { ...(modern ? { resultType: "complete" } : {}), ...toolResult } });
    } catch (error) {
      res.json({ jsonrpc: "2.0", id, result: { ...(modern ? { resultType: "complete" } : {}), ...errorResult(error) } });
    }
    return;
  }
  if (id === undefined) {
    res.status(202).end();
    return;
  }
  res.status(modern ? 404 : 200).json(rpcError(id, -32601, "Method not found."));
});

export default router;
