// Verifies the session token, loads the User, and attaches it to the request (Auth, error, and validation rules).
import type { NextFunction, Request, Response } from "express";
import type { HydratedDocument } from "mongoose";
import { hashToken, looksLikeApiToken } from "../lib/apiToken.js";
import { verifySessionToken } from "../lib/session.js";
import ApiToken from "../models/ApiToken.js";
import { isAdminUser } from "../lib/admins.js";
import User, { type UserDoc } from "../models/User.js";

// User object attached to the request after successful authentication.
export type SessionUser = HydratedDocument<UserDoc>;

// Extending the Express Request interface to include the user property.
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      // True when the signed-in user is listed in ADMIN_EMAILS (see lib/admins.ts).
      isAdmin?: boolean;
      // How the request was authenticated: a browser session or a personal API token.
      authMethod?: "session" | "token";
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// POST routes that only send files back and change nothing. (The font download is left out: it records a build in the history.)
const READ_POSTS = [/^\/api\/projects\/[^/]+\/icons\/download$/];
function isReadRequest(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const path = req.originalUrl.split("?")[0] ?? "";
  // MCP calls are read-only only when they name one of the read tools. New
  // write tools must stay outside this allowlist so read tokens cannot mutate.
  if (req.method === "POST" && /^\/mcp\/?$/.test(path)) {
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const method = body?.method;
    if (typeof method !== "string") return false;
    if (["initialize", "server/discover", "notifications/initialized", "ping", "tools/list"].includes(method)) return true;
    return method === "tools/call" && typeof body?.params?.name === "string" &&
      [
        "list_projects", "search_icons", "list_project_icons", "get_icon", "get_project_sprite",
        "get_project_detail", "get_project_fonticon", "list_project_versions", "get_icon_versions", "export_project",
        "list_font_builds", "get_font_build_zip", "list_sprite_builds", "get_sprite_build_zip",
        "search_icons_by_tag", "search_icons_by_folder", "project_activity", "audit_log",
      ].includes(body.params.name);
  }
  return req.method === "POST" && READ_POSTS.some((pattern) => pattern.test(path));
}

// Returns a function that requires a valid session token and loads the User into the request.
export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Extract the Authorization header from the request.
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  // Extract the token from the Authorization header.
  const token = header.slice("bearer ".length).trim();
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  // A personal API token: look it up by hash. Revoked tokens are refused. Tokens never carry admin rights, whatever the user's role is.
  if (looksLikeApiToken(token)) {
    try {
      const row = await ApiToken.findOne({ tokenHash: hashToken(token), revokedAt: null });
      const user = row ? await User.findById(row.userId) : null;
      if (!row || !user) {
        res.status(401).json({ error: "That API token is invalid or has been revoked." });
        return;
      }
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        res.status(401).json({ error: "That API token has expired. Create a new one." });
        return;
      }
      // Read-only tokens may only use methods that do not change data, plus the POST routes that only hand back a download.
      if ((row.scope ?? "write") === "read" && !isReadRequest(req)) {
        res.status(403).json({ error: "This is a read-only API token. Authenticate with a read/write API token to use write tools." });
        return;
      }
      // Recording the last use is a convenience; do it at most once a minute and never fail the request over it.
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
        ApiToken.updateOne({ _id: row._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
      }
      req.user = user;
      req.isAdmin = false;
      req.authMethod = "token";
      next();
    } catch {
      res.status(401).json({ error: "Invalid API token." });
    }
    return;
  }

  // Verify the session token and load the user from the database.
  try {
    const { claims, issuedAt } = await verifySessionToken(token);
    const user = await User.findById(claims.sub);
    if (!user) {
      res.status(401).json({ error: "Session user no longer exists." });
      return;
    }
    if (user.tokensValidAfter && issuedAt * 1000 < user.tokensValidAfter.getTime()) {
      res.status(401).json({ error: "This session was signed out. Please sign in again." });
      return;
    }
    req.user = user;
    req.isAdmin = isAdminUser(user);
    req.authMethod = "session";
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid session.";
    res.status(401).json({ error: message });
  }
}
