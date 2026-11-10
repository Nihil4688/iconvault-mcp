// Builds the Express app (middleware, routes, error handling) without starting a server, so the entry point and the tests can both use it.
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import authRouter from "./routes/authRoutes.js";
import meRouter from "./routes/sessionUserRoutes.js";
import projectRouter from "./routes/projectRoutes.js";
import folderRouter from "./routes/folderRoutes.js";
import iconRouter from "./routes/iconRoutes.js";
import adminRouter from "./routes/adminRoutes.js";
import tokenRouter from "./routes/tokenRoutes.js";
import mcpRouter from "./routes/mcpRoutes.js";
import { errorHandler } from "./lib/errors.js";
import { apiLimit, authLimit, configureRateLimits, limitsFromEnv, type RateLimitConfig } from "./middleware/rateLimit.js";
import { corsOptions, securityHeaders } from "./middleware/security.js";

export type AppOptions = {
  // Overrides the rate limits (tests); false turns them off. By default they come from the environment.
  rateLimit?: RateLimitConfig | false;
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  // Behind a reverse proxy set TRUST_PROXY (for example 1) so the real client address is used for rate limits.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }
  configureRateLimits(options.rateLimit ?? limitsFromEnv());

  app.use(securityHeaders);
  app.use(cors(corsOptions()));
  app.use("/api", apiLimit);
  app.use("/mcp", apiLimit);
  app.use(express.json({ limit: "5mb" }));

  app.get("/", (_req: Request, res: Response) => {
    res.send("Backend Running");
  });

  // Only the sign-in calls are counted as attempts; /api/auth/me is an ordinary request.
  app.use(["/api/auth/google", "/api/auth/microsoft"], authLimit);
  app.use("/api/auth", authRouter);
  app.use("/api/auth/me", meRouter);
  app.use("/api/projects", projectRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/tokens", tokenRouter);
  app.use("/mcp", mcpRouter);
  app.use("/api", folderRouter);
  app.use("/api", iconRouter);

  // Keep the runtime quiet if someone hits a path we don't serve.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Turns thrown errors (validation, permissions, bad ids) into JSON responses. Must stay after all routes.
  app.use(errorHandler);

  return app;
}
