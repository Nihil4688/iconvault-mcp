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
  // The MCP endpoint currently exposes only read-only tools. Keep the token's
  // read scope limited to the known JSON-RPC methods; if write tools are added,
  // they must not be included here.
  if (req.method === "POST" && /^\/mcp\/?$/.test(path)) {
    const method = (req.body as { method?: unknown } | undefined)?.method;
    return typeof method === "string" && ["initialize", "server/discover", "notifications/initialized", "ping", "tools/list", "tools/call"].includes(method);
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
        res.status(403).json({ error: "This API token is read-only. Create a token with write access to change data." });
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
