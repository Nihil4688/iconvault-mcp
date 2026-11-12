// Stateless Streamable HTTP MCP endpoint. Every request is authenticated with
// the same personal API token used by the REST API.
import { Router } from "express";
import { requireDb } from "../middleware/requireDb.js";
import { requireUser } from "../middleware/requireUser.js";
import { heavyLimit } from "../middleware/rateLimit.js";
import { toHttpError } from "../lib/errors.js";
import { callMcpTool, createToolsListResult, HEAVY_MCP_TOOLS, isMcpTool } from "./mcpTools.js";

export { createToolsListResult } from "./mcpTools.js";

const router = Router();
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_PROTOCOLS = [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS];
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
  if (body?.method === "tools/call" && typeof body.params?.name === "string" && HEAVY_MCP_TOOLS.has(body.params.name)) {
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
    res.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: SUPPORTED_PROTOCOLS, capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "iconvault", version: "1.0.0" } }, instructions: "Read projects and icons with a read token. Use a write token to add SVG source to projects you own or copy icons from other visible projects." } });
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
    res.json({ jsonrpc: "2.0", id, result: createToolsListResult(modern) });
    return;
  }
  if (body.method === "tools/call") {
    const params = body.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string") {
      res.json(rpcError(id, -32602, "Tool name is required."));
      return;
    }
    try {
      if (!isMcpTool(params.name)) {
        res.json(rpcError(id, -32602, `Unknown tool: ${params.name}`));
        return;
      }
      const toolResult = await callMcpTool(req, params.name, params.arguments);
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
