import { z } from "zod";
import mongoose from "mongoose";
import type { Request } from "express";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { actorOf, escapeRegExp, loadProject, parseObjectId } from "../lib/http.js";
import { createProjectSchema, updateProjectSchema, updateIconSchema, batchMoveSchema, batchTagSchema, batchDeleteSchema, buildFontSchema, copyIconsSchema, iconIdsSchema, objectId } from "../lib/validation.js";
import { listProjectsQuerySchema, pasteIconSchema } from "../lib/validation.js";
import Icon from "../models/Icon.js";
import IconVersion from "../models/IconVersion.js";
import ActivityLog from "../models/ActivityLog.js";
import Project from "../models/Project.js";
import { listFolders, assertFolderInProject } from "../services/folderService.js";
import { createProject, deleteProject, duplicateProject, getProjectDetail, updateProject } from "../services/projectService.js";
import { exportProject, importProject } from "../services/projectArchive.js";
import { batchDelete, batchMove, batchOptimize, batchTag, deletePermanently, emptyTrash, importSvg, importUpload, listIcons, listVersions, moveToTrash, optimizeIcon, restoreFromTrash, searchIcons, serializeIcon, updateIcon, copyIcons } from "../services/iconService.js";
import { readFontGlyphs, privateUseOnly, importGlyphs } from "../services/fontImport.js";
import { iconsForFont, buildFont, zipFontBuild } from "../services/fontService.js";
import { buildProjectSprite } from "../services/spriteService.js";
import { getFontBuildZip, listFontBuilds } from "../services/fontHistory.js";
import { getSpriteBuildZip, listSpriteBuilds } from "../services/spriteHistory.js";
import { recordRequestActivity } from "../services/activityLogService.js";
import { listProjects } from "../services/projectService.js";

const field = (type: string, description?: string) => ({ type, ...(description ? { description } : {}) });
const projectArg = field("string", "Project id.");
const iconArg = field("string", "Icon id.");
const idsArg = { type: "array", items: field("string"), minItems: 1, maxItems: 500 };

const buildFontSchemaShape = {
  scope: { type: "string", enum: ["all", "folder", "selected"] }, folderId: field("string"), iconIds: idsArg,
  formats: { type: "array", items: { type: "string", enum: ["woff2", "woff", "ttf", "eot", "svg"] } }, fontName: field("string"), prefix: field("string"), baseClass: field("string"), startCodepoint: field("string"),
  reassignCodepoints: field("boolean"), codepointOverrides: { type: "array", items: { type: "object", properties: { iconId: iconArg, codepoint: field("string") }, required: ["iconId", "codepoint"] } }, fontHeight: { type: "integer" }, descent: { type: "integer" }, normalize: field("boolean"),
};

const MCP_TOOLS = [
  { name: "list_projects", description: "List IconVault projects visible to the authenticated user.", inputSchema: { type: "object", properties: { search: { type: "string", maxLength: 100 }, scope: { type: "string", enum: ["all", "mine", "public"] }, purpose: { type: "string", enum: ["all", "sprite", "font"] }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
  { name: "search_icons", description: "Search active icons in projects visible to the authenticated user.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"] } },
  { name: "list_project_icons", description: "List icons in a project the user can view, optionally filtered by name, folder, or tag.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, search: { type: "string", maxLength: 100 }, folderId: { type: "string", description: "Folder id, or 'root' for uncategorized icons." }, tag: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 100 }, includeSvg: { type: "boolean" } }, required: ["projectId"] } },
  { name: "get_icon", description: "Get an icon's metadata and sanitized SVG markup, if its project is visible to the user.", inputSchema: { type: "object", properties: { iconId: { type: "string" } }, required: ["iconId"] } },
  { name: "get_project_sprite", description: "Build and return the SVG sprite for a project the user can view.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, folderId: { type: "string", description: "Optional folder id, or 'root' for uncategorized icons." } }, required: ["projectId"] } },
  { name: "add_icon", description: "Add an SVG icon from source code to a project you own. Requires a write token.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string", maxLength: 100 }, rawSvg: { type: "string", maxLength: 1000000 }, folderId: { type: ["string", "null"] }, tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 50 }, optimize: { type: "boolean" }, strategy: { type: "string", enum: ["rename", "replace", "skip"] } }, required: ["projectId", "rawSvg"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "copy_icons", description: "Copy selected icons from another visible project into a project you own. Requires a write token.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, sourceProjectId: { type: "string" }, iconIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 }, folderId: { type: ["string", "null"] }, strategy: { type: "string", enum: ["rename", "replace", "skip"] }, optimize: { type: "boolean" } }, required: ["projectId", "sourceProjectId", "iconIds"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "get_project_detail", description: "Read full project metadata, folder structure, and active/trash counts.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] } },
  { name: "get_project_fonticon", description: "List a project's font icons and their codepoint mappings, optionally filtered by folder or search.", inputSchema: { type: "object", properties: { projectId: projectArg, folderId: field("string", "Folder id, or 'root'."), search: field("string"), limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectId"] } },
  { name: "list_project_versions", description: "Read saved SVG version history for icons in a project.", inputSchema: { type: "object", properties: { projectId: projectArg, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectId"] } },
  { name: "get_icon_versions", description: "Read saved SVG version history for an icon.", inputSchema: { type: "object", properties: { iconId: iconArg }, required: ["iconId"] } },
  { name: "export_project", description: "Export a visible project archive as base64 encoded ZIP data.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] } },
  { name: "list_font_builds", description: "List saved font ZIP builds for a project.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] } },
  { name: "get_font_build_zip", description: "Download a saved font build as base64 encoded ZIP data.", inputSchema: { type: "object", properties: { projectId: projectArg, buildId: field("string") }, required: ["projectId", "buildId"] } },
  { name: "list_sprite_builds", description: "List saved sprite ZIP builds for a project.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] } },
  { name: "get_sprite_build_zip", description: "Download a saved sprite build as base64 encoded ZIP data.", inputSchema: { type: "object", properties: { projectId: projectArg, buildId: field("string") }, required: ["projectId", "buildId"] } },
  { name: "search_icons_by_tag", description: "Find icons by tag, optionally within one project.", inputSchema: { type: "object", properties: { tag: field("string"), projectId: projectArg, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["tag"] } },
  { name: "search_icons_by_folder", description: "Browse icons in a folder or project root.", inputSchema: { type: "object", properties: { projectId: projectArg, folderId: field("string", "Folder id, or 'root'."), limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectId"] } },
  { name: "project_activity", description: "Read recent activity for a visible project.", inputSchema: { type: "object", properties: { projectId: projectArg, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectId"] } },
  { name: "audit_log", description: "Alias for project_activity; read recent activity for a visible project.", inputSchema: { type: "object", properties: { projectId: projectArg, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectId"] } },
  { name: "create_project", description: "Create a project owned by the authenticated user.", inputSchema: { type: "object", properties: { name: field("string"), description: field("string"), prefix: field("string"), color: field("string"), purpose: { type: "string", enum: ["sprite", "font"] }, visibility: { type: "string", enum: ["public", "private"] } }, required: ["name"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "update_project", description: "Update settings of a project you own.", inputSchema: { type: "object", properties: { projectId: projectArg, name: field("string"), description: field("string"), prefix: field("string"), color: field("string"), visibility: { type: "string", enum: ["public", "private"] }, isArchived: field("boolean"), uncategorizedName: field("string") }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "delete_project", description: "Permanently delete a project and its icons, versions, folders, and build history.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "duplicate_project", description: "Duplicate a visible project into a new private project owned by you.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "import_project", description: "Import a project export from base64 encoded ZIP data.", inputSchema: { type: "object", properties: { archiveBase64: field("string") }, required: ["archiveBase64"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "import_project_export", description: "Alias for import_project; restore from a base64 encoded project export ZIP.", inputSchema: { type: "object", properties: { archiveBase64: field("string") }, required: ["archiveBase64"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "upload_icons", description: "Upload SVG or ZIP files to a project you own. File content must be base64 encoded.", inputSchema: { type: "object", properties: { projectId: projectArg, files: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", properties: { filename: field("string"), contentBase64: field("string") }, required: ["filename", "contentBase64"] } }, folderId: field("string"), tags: { type: "array", items: field("string"), maxItems: 50 }, optimize: field("boolean"), strategy: { type: "string", enum: ["rename", "replace", "skip"] } }, required: ["projectId", "files"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "import_font_glyphs", description: "Import glyphs from a base64 encoded font file into a project you own.", inputSchema: { type: "object", properties: { projectId: projectArg, fontBase64: field("string"), mapping: field("string"), folderId: field("string"), privateUseOnly: field("boolean"), optimize: field("boolean"), strategy: { type: "string", enum: ["rename", "replace", "skip"] } }, required: ["projectId", "fontBase64"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "update_icon", description: "Update an icon's name, folder, tags, codepoint, or sanitized SVG.", inputSchema: { type: "object", properties: { iconId: iconArg, name: field("string"), folderId: { type: ["string", "null"] }, tags: { type: "array", items: field("string") }, codepoint: { type: ["string", "null"] }, rawSvg: field("string") }, required: ["iconId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "delete_icon", description: "Move an icon to trash or permanently delete it if already trashed.", inputSchema: { type: "object", properties: { iconId: iconArg, permanent: field("boolean") }, required: ["iconId"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "move_icon_to_trash", description: "Move an icon to its project's trash.", inputSchema: { type: "object", properties: { iconId: iconArg }, required: ["iconId"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "restore_icon", description: "Restore an icon from its project's trash.", inputSchema: { type: "object", properties: { iconId: iconArg }, required: ["iconId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "batch_delete_icons", description: "Move selected icons to trash or permanently delete trashed icons.", inputSchema: { type: "object", properties: { projectId: projectArg, iconIds: idsArg, permanent: field("boolean") }, required: ["projectId", "iconIds"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "batch_move_icons", description: "Move selected icons to a folder or another project. Cross-project moves copy into the destination and put originals in the source trash, preserving a recovery path.", inputSchema: { type: "object", properties: { projectId: projectArg, sourceProjectId: field("string", "Optional source project id for a cross-project move."), iconIds: idsArg, folderId: { type: ["string", "null"], description: "Destination folder id; use null or 'root' for the project root." }, strategy: { type: "string", enum: ["rename", "replace", "skip"] } }, required: ["projectId", "iconIds", "folderId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "batch_tag_icons", description: "Add, remove, or replace tags on selected icons.", inputSchema: { type: "object", properties: { projectId: projectArg, iconIds: idsArg, tags: { type: "array", items: field("string"), minItems: 1, maxItems: 50 }, mode: { type: "string", enum: ["add", "remove", "set"] } }, required: ["projectId", "iconIds", "tags"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "optimize_icon", description: "Optimize a project's icon SVG.", inputSchema: { type: "object", properties: { iconId: iconArg }, required: ["iconId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "batch_optimize_icons", description: "Optimize SVGs for selected icons in a project.", inputSchema: { type: "object", properties: { projectId: projectArg, iconIds: idsArg }, required: ["projectId", "iconIds"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "empty_trash", description: "Permanently delete all trashed icons and their saved versions in a project.", inputSchema: { type: "object", properties: { projectId: projectArg }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "build_font", description: "Build a font preview and return CSS, codepoints, warnings, and optional ZIP data.", inputSchema: { type: "object", properties: { projectId: projectArg, downloadZip: field("boolean"), ...buildFontSchemaShape }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "build_project_sprite", description: "Rebuild an SVG sprite for a project or one folder.", inputSchema: { type: "object", properties: { projectId: projectArg, folderId: field("string", "Folder id, or 'root'.") }, required: ["projectId"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
] as const;

export const HEAVY_MCP_TOOLS = new Set(["get_project_sprite", "build_project_sprite", "add_icon", "copy_icons", "export_project", "import_project", "import_project_export", "upload_icons", "import_font_glyphs", "build_font", "batch_optimize_icons"]);

export function createToolsListResult(modern: boolean) {
  const tools = MCP_TOOLS.map((tool) => ({ ...tool, annotations: ("annotations" in tool ? tool.annotations : undefined) ?? { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
  return modern ? { resultType: "complete" as const, ttlMs: 300_000, cacheScope: "public" as const, tools } : { tools };
}

export function isMcpTool(name: string): boolean { return MCP_TOOLS.some((tool) => tool.name === name); }

function result(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }
function binaryResult(value: { filename: string; contentType: string; size: number; encoding: "base64"; data: string }) {
  const { data: _data, ...metadata } = value;
  return { content: [{ type: "text", text: JSON.stringify({ ...metadata, data: "See structuredContent.data." }) }], structuredContent: value };
}
function decodeBase64(value: string, label: string, maxBytes: number): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new BadRequestError(`${label} must be valid base64 data.`);
  const data = Buffer.from(value, "base64");
  if (data.length > maxBytes) throw new BadRequestError(`${label} exceeds the ${maxBytes} byte MCP limit.`);
  return data;
}
const optionalString = z.string().trim().max(100).optional();
const defaultedArgs = (raw: unknown) => z.record(z.string(), z.unknown()).parse(raw ?? {});

export async function callMcpTool(req: Request, name: string, raw: unknown) {
  const args = defaultedArgs(raw);
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
      const limit = input.includeSvg ? Math.min(input.limit ?? 100, 3) : input.limit ?? 100;
      return result(await listIcons(project._id, { folder, includeSubfolders: false, search: input.search, tag: input.tag, trash: false, sort: "name", page: 1, limit, withSvg: input.includeSvg ?? false }));
    }
    case "get_icon": {
      const { iconId } = z.object({ iconId: z.string().min(1).max(100) }).strict().parse(args);
      const icon = await Icon.findById(parseObjectId(iconId, "icon id"));
      if (!icon || icon.deletedAt) throw new NotFoundError("Icon not found.");
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
    case "add_icon": {
      const input = pasteIconSchema.extend({ projectId: z.string().min(1).max(100) }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "edit");
      const folderId = input.folderId ? parseObjectId(input.folderId, "folder id") : null;
      await assertFolderInProject(project._id, folderId);
      const outcome = await importSvg(project._id, { name: input.name, raw: input.rawSvg, folderId, tags: input.tags }, { strategy: input.strategy, optimize: input.optimize });
      if (outcome.status === "skipped") return result({ outcome: "skipped", reason: outcome.reason });
      await recordRequestActivity(req, project, {
        actionDone: outcome.status === "created" ? "upload" : "update", entityType: "icon", entityId: outcome.icon._id, entityName: outcome.icon.name,
        details: { source: "mcp", outcome: outcome.status, byteSize: outcome.icon.byteSize, folderId: outcome.icon.folderId ? String(outcome.icon.folderId) : null, tags: outcome.icon.tags },
      });
      return result({ outcome: outcome.status, icon: serializeIcon(outcome.icon) });
    }
    case "get_project_detail": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const project = await loadProject(actor, projectId, "view");
      return result({ ...(await getProjectDetail(project, actor)), ...await listFolders(project._id) });
    }
    case "get_project_fonticon": {
      const input = z.object({ projectId: objectId, folderId: z.string().max(100).optional(), search: optionalString, limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const folder = input.folderId === undefined ? "all" : input.folderId === "root" ? "root" : parseObjectId(input.folderId, "folder id");
      const filter: Record<string, unknown> = { projectId: project._id, deletedAt: null };
      if (folder === "root") filter.folderId = null;
      else if (folder !== "all") filter.folderId = folder;
      if (input.search) { const pattern = new RegExp(escapeRegExp(input.search), "i"); filter.$or = [{ name: pattern }, { slug: pattern }, { tags: pattern }]; }
      const [icons, total] = await Promise.all([
        Icon.find(filter, { svg: 0 }).sort({ name: 1, _id: 1 }).collation({ locale: "en", strength: 2 }).limit(input.limit ?? 100).lean(),
        Icon.countDocuments(filter),
      ]);
      return result({ total, page: 1, limit: input.limit ?? 100, icons: icons.map((icon) => ({ ...serializeIcon({ ...icon, svg: "" }, false), fontCodepoint: icon.fontCodepoint ?? null })) });
    }
    case "list_project_versions": {
      const input = z.object({ projectId: objectId, limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const icons = await Icon.find({ projectId: project._id }, { name: 1, deletedAt: 1 }).sort({ name: 1 }).limit(input.limit ?? 100).lean();
      const versions = await IconVersion.find({ iconId: { $in: icons.map((icon) => icon._id) } }).sort({ createdAt: -1, _id: -1 }).select({ iconId: 1, byteSize: 1, createdAt: 1 }).lean();
      const byIcon = new Map(icons.map((icon) => [String(icon._id), { iconId: String(icon._id), name: icon.name, deleted: Boolean(icon.deletedAt), versions: [] as unknown[] }]));
      for (const version of versions) byIcon.get(String(version.iconId))?.versions.push({ id: String(version._id), byteSize: version.byteSize, createdAt: version.createdAt });
      return result({ icons: [...byIcon.values()], totalIcons: icons.length });
    }
    case "get_icon_versions": {
      const { iconId } = z.object({ iconId: objectId }).strict().parse(args);
      const icon = await Icon.findById(iconId);
      if (!icon) throw new NotFoundError("Icon not found.");
      await loadProject(actor, icon.projectId, "view");
      return result({ iconId: String(icon._id), versions: await listVersions(icon._id) });
    }
    case "export_project": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const project = await loadProject(actor, projectId, "view");
      const archive = await exportProject(project);
      return binaryResult({ filename: archive.filename, contentType: archive.contentType, size: archive.body.length, encoding: "base64", data: archive.body.toString("base64") });
    }
    case "list_font_builds": case "list_sprite_builds": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const project = await loadProject(actor, projectId, "view");
      return result(name === "list_font_builds" ? { builds: await listFontBuilds(project._id) } : { builds: await listSpriteBuilds(project._id) });
    }
    case "get_font_build_zip": case "get_sprite_build_zip": {
      const input = z.object({ projectId: objectId, buildId: objectId }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const file = name === "get_font_build_zip" ? await getFontBuildZip(project._id, input.buildId) : await getSpriteBuildZip(project._id, input.buildId);
      return binaryResult({ filename: "filename" in file ? file.filename : `${project.prefix ?? "icon"}-sprite-v${file.version}.zip`, contentType: "application/zip", size: file.zip.length, encoding: "base64", data: file.zip.toString("base64") });
    }
    case "search_icons_by_tag": case "search_icons_by_folder": {
      const input = name === "search_icons_by_tag"
        ? z.object({ tag: z.string().trim().min(1).max(40), projectId: objectId.optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(args)
        : z.object({ projectId: objectId, folderId: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      if (name === "search_icons_by_folder") {
        const project = await loadProject(actor, (input as { projectId: string }).projectId, "view");
        const folderId = (input as { folderId?: string }).folderId;
        const folder = folderId === undefined ? "all" : folderId === "root" ? "root" : parseObjectId(folderId, "folder id");
        return result(await listIcons(project._id, { folder, includeSubfolders: false, trash: false, sort: "name", page: 1, limit: (input as any).limit ?? 100, withSvg: false }));
      }
      const tag = (input as { tag: string }).tag.toLowerCase();
      if ((input as { projectId?: string }).projectId) {
        const project = await loadProject(actor, (input as { projectId: string }).projectId, "view");
        return result(await listIcons(project._id, { folder: "all", includeSubfolders: false, tag, trash: false, sort: "name", page: 1, limit: (input as any).limit ?? 100, withSvg: false }));
      }
      const projectFilter = actor.isAdmin ? { isArchived: false } : { isArchived: false, $or: [{ ownerId: new mongoose.Types.ObjectId(actor.id) }, { visibility: "public" as const }] };
      const visibleIds = await Project.find(projectFilter).distinct("_id");
      const found = await Icon.find({ projectId: { $in: visibleIds }, deletedAt: null, tags: tag }).sort({ name: 1, _id: 1 }).limit((input as any).limit ?? 100).lean();
      return result({ icons: found.map((icon) => serializeIcon(icon, false)), total: await Icon.countDocuments({ projectId: { $in: visibleIds }, deletedAt: null, tags: tag }), page: 1, limit: (input as any).limit ?? 100 });
    }
    case "project_activity": case "audit_log": {
      const input = z.object({ projectId: objectId, limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const activities = await ActivityLog.find({ projectId: project._id }).sort({ timestamp: -1, _id: -1 }).limit(input.limit ?? 50).lean();
      return result({ activities: activities.map(({ _id, performedById, ownerId, projectId: pId, entityId, affectedEntityIds, ...entry }) => ({ ...entry, id: String(_id), performedById: String(performedById), ownerId: String(ownerId), projectId: String(pId), entityId: entityId ? String(entityId) : null, affectedEntityIds: (affectedEntityIds ?? []).map(String) })) });
    }
    case "create_project": {
      const input = createProjectSchema.parse(args);
      const project = await createProject(actor, input);
      await recordRequestActivity(req, { _id: parseObjectId(project.id), name: project.name, ownerId: parseObjectId(project.owner.id) }, { actionDone: "create", entityType: "project", entityId: parseObjectId(project.id), entityName: project.name, details: { source: "mcp" } });
      return result(project);
    }
    case "update_project": {
      const { projectId, ...data } = z.object({ projectId: objectId }).passthrough().parse(args);
      const input = updateProjectSchema.parse(data);
      const project = await loadProject(actor, projectId, "manage");
      const before = Object.fromEntries(Object.keys(input).map((key) => [key, project.get(key)]));
      const updated = await updateProject(project, input, actor);
      const changes = Object.fromEntries(Object.keys(input).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(project.get(key))).map((key) => [key, { before: before[key], after: project.get(key) }]));
      if (Object.keys(changes).length) await recordRequestActivity(req, project, { actionDone: "update", entityType: "project", entityId: project._id, entityName: project.name, changes, details: { source: "mcp" } });
      return result(updated);
    }
    case "delete_project": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const project = await loadProject(actor, projectId, "manage");
      const deleted = await deleteProject(project);
      await recordRequestActivity(req, project, { actionDone: "delete", entityType: "project", entityId: project._id, entityName: project.name, details: deleted });
      return result(deleted);
    }
    case "duplicate_project": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const source = await loadProject(actor, projectId, "view");
      const project = await duplicateProject(source, actor);
      await recordRequestActivity(req, { _id: parseObjectId(project.id), name: project.name, ownerId: parseObjectId(project.owner.id) }, { actionDone: "duplicate", entityType: "project", entityId: parseObjectId(project.id), entityName: project.name, details: { sourceProjectId: projectId, sourceProjectName: source.name } });
      return result(project);
    }
    case "import_project": case "import_project_export": {
      const { archiveBase64 } = z.object({ archiveBase64: z.string().min(1).max(35_000_000) }).strict().parse(args);
      const imported = await importProject(actor, decodeBase64(archiveBase64, "Project archive", 25 * 1024 * 1024));
      await recordRequestActivity(req, { _id: parseObjectId(imported.project.id), name: imported.project.name, ownerId: parseObjectId(imported.project.owner.id) }, { actionDone: "import", entityType: "project", entityId: parseObjectId(imported.project.id), entityName: imported.project.name, details: { iconCount: imported.imported, foldersCreated: imported.foldersCreated, source: "mcp" }, result: imported.problems.length ? "partial" : "success" });
      return result(imported);
    }
    case "upload_icons": {
      const input = z.object({ projectId: objectId, files: z.array(z.object({ filename: z.string().trim().min(1).max(255), contentBase64: z.string().min(1).max(35_000_000) }).strict()).min(1).max(200), folderId: z.string().max(100).optional(), tags: z.array(z.string().max(40)).max(50).optional(), optimize: z.boolean().optional(), strategy: z.enum(["rename", "replace", "skip"]).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "edit");
      const folderId = input.folderId && input.folderId !== "root" ? parseObjectId(input.folderId, "folder id") : null;
      const files = input.files.map((file) => ({ originalname: file.filename, mimetype: file.filename.toLowerCase().endsWith(".zip") ? "application/zip" : "image/svg+xml", buffer: decodeBase64(file.contentBase64, file.filename, 25 * 1024 * 1024) }));
      const summary = await importUpload(project._id, files, { folderId, tags: input.tags ?? [], optimize: input.optimize ?? true, strategy: input.strategy ?? "rename" });
      const count = summary.created.length + summary.replaced.length;
      if (count) await recordRequestActivity(req, project, { actionDone: "upload", entityType: "icon", details: { source: "mcp", createdCount: summary.created.length, replacedCount: summary.replaced.length, affectedCount: count, errorCount: summary.errors.length }, result: summary.errors.length ? "partial" : "success" });
      return result(summary);
    }
    case "import_font_glyphs": {
      const input = z.object({ projectId: objectId, fontBase64: z.string().min(1).max(11_200_000), mapping: z.string().max(1_000_000).optional(), folderId: z.string().max(100).optional(), privateUseOnly: z.boolean().optional(), optimize: z.boolean().optional(), strategy: z.enum(["rename", "replace", "skip"]).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "edit");
      const font = decodeBase64(input.fontBase64, "Font", 8 * 1024 * 1024);
      const read = await readFontGlyphs(font, input.mapping ?? "");
      const glyphs = input.privateUseOnly === false ? read.glyphs : privateUseOnly(read.glyphs);
      if (glyphs.length === 0) throw new BadRequestError(input.privateUseOnly !== false && read.glyphs.length ? "This font has no icons in the Private Use Area. Set privateUseOnly to false to include every glyph." : "This font has no glyphs with outlines to import.");
      const folderId = input.folderId && input.folderId !== "root" ? parseObjectId(input.folderId, "folder id") : null;
      await assertFolderInProject(project._id, folderId);
      const summary = await importGlyphs(project._id, glyphs, { strategy: input.strategy ?? "rename", optimize: input.optimize ?? true, folderId });
      if (summary.created.length + summary.replaced.length) await recordRequestActivity(req, project, { actionDone: "upload", entityType: "icon", details: { source: "mcp font import", fontKind: read.kind, createdCount: summary.created.length, replacedCount: summary.replaced.length }, result: summary.errors.length ? "partial" : "success" });
      return result({ kind: read.kind, total: read.total, importable: glyphs.length, truncated: read.truncated, ...summary });
    }
    case "update_icon": {
      const { iconId, ...data } = z.object({ iconId: objectId }).passthrough().parse(args);
      const input = updateIconSchema.parse(data);
      const icon = await Icon.findById(iconId);
      if (!icon) throw new NotFoundError("Icon not found.");
      const project = await loadProject(actor, icon.projectId, "edit");
      const before = { name: icon.name, tags: [...icon.tags], folderId: icon.folderId ? String(icon.folderId) : null, codepoint: icon.codepoint, svg: icon.svg, byteSize: icon.byteSize };
      const updated = await updateIcon(icon, input);
      const changes: Record<string, unknown> = Object.fromEntries(Object.keys(input).filter((key) => key !== "rawSvg" && JSON.stringify((before as any)[key]) !== JSON.stringify((updated as any)[key])).map((key) => [key, { before: (before as any)[key], after: (updated as any)[key] }]));
      if (input.rawSvg !== undefined && updated.svg !== before.svg) changes.svg = { beforeByteSize: before.byteSize, afterByteSize: updated.byteSize };
      if (Object.keys(changes).length) await recordRequestActivity(req, project, { actionDone: "update", entityType: "icon", entityId: updated._id, entityName: updated.name, changes, details: { source: "mcp" } });
      return result(serializeIcon(updated));
    }
    case "delete_icon": case "move_icon_to_trash": case "restore_icon": case "optimize_icon": {
      const { iconId, permanent } = z.object({ iconId: objectId, permanent: z.boolean().optional() }).strict().parse(args);
      const icon = await Icon.findById(iconId);
      if (!icon) throw new NotFoundError("Icon not found.");
      const project = await loadProject(actor, icon.projectId, "edit");
      if (name === "restore_icon") {
        const wasTrashed = Boolean(icon.deletedAt);
        const restored = await restoreFromTrash(icon);
        if (wasTrashed) await recordRequestActivity(req, project, { actionDone: "restore", entityType: "icon", entityId: icon._id, entityName: restored.icon.name, details: { adjusted: restored.adjusted, source: "mcp" } });
        return result({ icon: serializeIcon(restored.icon, false), adjusted: restored.adjusted });
      }
      if (name === "optimize_icon") {
        const optimized = await optimizeIcon(icon);
        if (optimized.changed) await recordRequestActivity(req, project, { actionDone: "optimize", entityType: "icon", entityId: icon._id, entityName: icon.name, details: { bytesBefore: optimized.before, bytesAfter: optimized.after, savingsPercent: optimized.savingsPercent, source: "mcp" } });
        return result({ icon: serializeIcon(optimized.icon), changed: optimized.changed, before: optimized.before, after: optimized.after, savingsPercent: optimized.savingsPercent });
      }
      if (permanent) {
        const deletedVersions = await IconVersion.countDocuments({ iconId: icon._id });
        await deletePermanently(icon);
        await recordRequestActivity(req, project, { actionDone: "delete", entityType: "icon", entityId: icon._id, entityName: icon.name, details: { deletionMode: "permanent", deletedVersions, source: "mcp" } });
        return result({ deleted: true });
      }
      const trashed = await moveToTrash(icon);
      await recordRequestActivity(req, project, { actionDone: "delete", entityType: "icon", entityId: icon._id, entityName: icon.name, details: { source: "mcp", deletionMode: "trash" } });
      return result(serializeIcon(trashed, false));
    }
    case "batch_delete_icons": case "batch_move_icons": case "batch_tag_icons": case "batch_optimize_icons": {
      const { projectId } = z.object({ projectId: objectId }).passthrough().parse(args);
      const project = await loadProject(actor, projectId, "edit");
      if (name === "batch_delete_icons") {
        const i = batchDeleteSchema.parse({ iconIds: args.iconIds, permanent: args.permanent }); const ids = i.iconIds.map((id) => parseObjectId(id));
        const changed = await batchDelete(project._id, ids, i.permanent);
        if (changed.matched) await recordRequestActivity(req, project, { actionDone: "delete", entityType: "icon", details: { deletionMode: i.permanent ? "permanent" : "trash", deletedCount: changed.matched, requestedCount: changed.requested, source: "mcp" } });
        return result(changed);
      }
      if (name === "batch_move_icons") {
        const moveArgs = z.object({ projectId: objectId, sourceProjectId: objectId.optional(), iconIds: z.array(objectId).min(1).max(500), folderId: z.string().max(100).nullable(), strategy: z.enum(["rename", "replace", "skip"]).optional() }).strict().parse(args);
        const ids = moveArgs.iconIds.map((id) => parseObjectId(id));
        const destinationFolder = moveArgs.folderId && moveArgs.folderId !== "root" ? parseObjectId(moveArgs.folderId, "folder id") : null;
        if (moveArgs.sourceProjectId && moveArgs.sourceProjectId !== moveArgs.projectId) {
          const source = await loadProject(actor, moveArgs.sourceProjectId, "edit");
          const available = await Icon.countDocuments({ projectId: source._id, _id: { $in: ids }, deletedAt: null });
          if (available !== ids.length) throw new NotFoundError("One or more icons were not found in the source project.");
          const copied = await copyIcons(project._id, source._id, ids, { strategy: moveArgs.strategy ?? "rename", optimize: false, folderId: destinationFolder });
          const complete = copied.errors.length === 0 && copied.skipped.length === 0 && copied.created.length + copied.replaced.length === ids.length;
          if (complete) {
            const trashed = await batchDelete(source._id, ids, false);
            await recordRequestActivity(req, source, { actionDone: "move", entityType: "icon", details: { movedCount: trashed.matched, destinationProjectId: String(project._id), source: "mcp" } });
          }
          if (copied.created.length + copied.replaced.length) await recordRequestActivity(req, project, { actionDone: "copy", entityType: "icon", details: { sourceProjectId: String(source._id), createdCount: copied.created.length, replacedCount: copied.replaced.length, affectedCount: copied.created.length + copied.replaced.length, source: "mcp cross-project move" }, result: complete ? "success" : "partial" });
          return result({ ...copied, moved: complete, originalsTrashed: complete ? ids.length : 0 });
        }
        const i = batchMoveSchema.parse({ iconIds: moveArgs.iconIds, folderId: destinationFolder ? String(destinationFolder) : null }); const changed = await batchMove(project._id, ids, i.folderId ? parseObjectId(i.folderId) : null);
        if (changed.matched) await recordRequestActivity(req, project, { actionDone: "move", entityType: "icon", details: { matchedCount: changed.matched, destinationFolderId: i.folderId, source: "mcp" } });
        return result(changed);
      }
      if (name === "batch_tag_icons") {
        const i = batchTagSchema.parse({ iconIds: args.iconIds, tags: args.tags, mode: args.mode }); const changed = await batchTag(project._id, i.iconIds.map((id) => parseObjectId(id)), i.tags, i.mode);
        if (changed.matched) await recordRequestActivity(req, project, { actionDone: "tag", entityType: "icon", details: { matchedCount: changed.matched, tags: i.tags, mode: i.mode, source: "mcp" } });
        return result(changed);
      }
      const i = iconIdsSchema.parse({ iconIds: args.iconIds });
      const optimized = await batchOptimize(project._id, i.iconIds.map((id) => parseObjectId(id)));
      if (optimized.optimized) await recordRequestActivity(req, project, { actionDone: "optimize", entityType: "icon", details: { optimizedCount: optimized.optimized, matchedCount: optimized.matched, bytesBefore: optimized.bytesBefore, bytesAfter: optimized.bytesAfter, source: "mcp" }, result: optimized.failed.length ? "partial" : "success" });
      return result(optimized);
    }
    case "empty_trash": {
      const { projectId } = z.object({ projectId: objectId }).strict().parse(args);
      const project = await loadProject(actor, projectId, "edit");
      const emptied = await emptyTrash(project._id);
      if (emptied.deleted) await recordRequestActivity(req, project, { actionDone: "clear", entityType: "project", entityId: project._id, entityName: project.name, details: { deletedCount: emptied.deleted, source: "mcp" } });
      return result(emptied);
    }
    case "build_font": {
      const { projectId, downloadZip, ...data } = z.object({ projectId: objectId, downloadZip: z.boolean().optional() }).passthrough().parse(args);
      const input = buildFontSchema.parse(data);
      const project = await loadProject(actor, projectId, "view");
      const build = await buildFont(project._id, await iconsForFont(project._id, input), input);
      await recordRequestActivity(req, project, { actionDone: "build", entityType: "project", entityId: project._id, entityName: project.name, buildType: "font", details: { source: "mcp", fontName: build.fontName, iconCount: build.iconCount, formats: input.formats } });
      const dataOut: Record<string, unknown> = { fontName: build.fontName, prefix: build.prefix, baseClass: build.baseClass, iconCount: build.iconCount, warnings: build.warnings, codepoints: build.codepoints, css: build.css, preview: build.preview, sizes: build.sizes };
      if (downloadZip) { const zip = zipFontBuild(build); dataOut.zipBase64 = zip.toString("base64"); dataOut.zipSize = zip.length; }
      if (downloadZip) return { content: [{ type: "text", text: JSON.stringify({ ...dataOut, zipBase64: "See structuredContent.zipBase64." }) }], structuredContent: dataOut };
      return result(dataOut);
    }
    case "build_project_sprite": {
      const input = z.object({ projectId: objectId, folderId: z.string().max(100).optional() }).strict().parse(args);
      const project = await loadProject(actor, input.projectId, "view");
      const folder = input.folderId === undefined ? null : input.folderId === "root" ? "root" : parseObjectId(input.folderId, "folder id");
      const sprite = await buildProjectSprite(project._id, project.prefix ?? "icon", folder);
      await recordRequestActivity(req, project, { actionDone: "build", entityType: "project", entityId: project._id, entityName: project.name, buildType: "sprite", details: { source: "mcp", iconCount: sprite.ids.length } });
      return result({ iconCount: sprite.ids.length, svg: sprite.xml });
    }
    case "copy_icons": {
      const input = copyIconsSchema.extend({ projectId: objectId }).strict().parse(args);
      const target = await loadProject(actor, input.projectId, "edit");
      const source = await loadProject(actor, input.sourceProjectId, "view");
      const copied = await copyIcons(target._id, source._id, input.iconIds.map((id) => parseObjectId(id)), { strategy: input.strategy, optimize: input.optimize, folderId: input.folderId ? parseObjectId(input.folderId) : null });
      if (copied.created.length + copied.replaced.length) await recordRequestActivity(req, target, { actionDone: "copy", entityType: "icon", details: { sourceProjectId: String(source._id), createdCount: copied.created.length, replacedCount: copied.replaced.length, affectedCount: copied.created.length + copied.replaced.length }, result: copied.errors.length ? "partial" : "success" });
      return result(copied);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
