# IconVault

Keep SVG icons in projects and folders, and compile them into a single `sprite.svg` (`<symbol>` + `<use>`) with a live preview, snippets and a download bundle. Sign-in is required; projects are private or public (public ones are read-only for others, who can copy icons).

- **Client** (`client/`): React 19 + TypeScript + Vite + Tailwind CSS 4. Compiling the sprite (symbols, grid sprite, demo page, preview image, ZIP) runs in the browser.
- **Server** (`server/`): Express 5 + TypeScript + MongoDB (Mongoose). Handles sign-in, projects, folders and icons (uploads are cleaned and optimized on the server).

## Features

- Sign-in with Google or Microsoft is required. A signed-out visitor sees a landing page.
- Projects dashboard and workspaces: folders, search, grid or table, bulk move / tag / optimize / download, trash with Undo, icon details drawer with versions, settings.
- Each project has one bar with its name, prefix, type and visibility, a pill menu (Icons, Font Builder or Sprite Builder, Project Settings, Trash) and the **Upload icons** and **From Another Project** buttons. The folder sidebar has a **+** for new folders. The Icons toolbar adds an icon **size** slider, **colour** swatches and a **style** switch (Natural, Flat, Wireframe) that only change how icons are previewed.
- The Icons page has an **Upload icons** button with a menu: upload SVG files or ZIPs, copy from another project, import an SVG sprite (each symbol becomes an icon), import an icon font (each glyph becomes an icon), or paste SVG code.
- Icon fonts (projects created as "font" projects): build a font from all icons or one folder as WOFF2, WOFF, TTF, EOT and/or SVG font, preview every glyph with its class and character, and download a ZIP (the font builds by itself when you open the page and when settings change) with the fonts, CSS, SCSS, a glyph map, a specimen page and a README. Each icon keeps its character between builds. Existing TTF, OTF, WOFF, WOFF2 or SVG fonts are imported from the Icons page's Upload icons menu.
- Move projects in and out: export a project as one ZIP (settings, folders, icons) and import it as a new private project, in the interface or with the command line.
- Administrators (emails in `ADMIN_EMAILS`) get a **Manage** menu in the top bar: **Manage Users** (list users, delete a user, their projects are deleted or handed to someone else) and **Manage Projects** (every project with its owner, searchable by owner, open, transfer to another owner, delete, and tick several to transfer or delete together). Both screens start with workspace totals. Try them with demo data: `npm run seed:demo` in `server/` (remove it again with `npm run seed:demo -- --remove`). The Manage button needs your e-mail in `ADMIN_EMAILS`. There are no passwords.
- Personal API tokens (account menu, API tokens) for the command line and scripts: shown once, revocable, never admin.
- Stateless Streamable HTTP MCP endpoint (`/mcp`) for MCP clients, authenticated with personal API tokens and the same project permissions.
- Select icons and press Build sprite (or Build font in a font project): a font project builds the font right away and opens the Font page with the finished result and Download font as the main action; a sprite project opens the Sprite page. The icons show as "Chosen icons", and Review / edit checklist (search, folder filter, group by folder, select or deselect whole folders) changes the choice. The Font page groups its controls (Icons, Font settings, Target formats) under the actions and lists every glyph once in the codepoint mapping table.
- Sprite section: compile all icons or one folder into a sprite in the browser; preview, copy, download `sprite.svg`, or download a ZIP with the sprite, a grid sprite, `demo.html` and `preview.png`; copy the `<use>` code for each symbol.
- Colour theme: light, dark or follow the system (switch in the header; the choice is remembered).

## Prerequisites

- Node.js 18+ and npm
- A MongoDB connection string (local or Atlas)
- OAuth client ids for Google and/or Microsoft (signing in is required to use the app)

## Setup

```bash
cd server && npm install
cd ../client && npm install
```

### Server environment (`server/.env`)

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | Yes | MongoDB connection string. The server will not start without it. |
| `SESSION_SECRET` | Yes | Secret used to sign session JWTs (HS256). Minimum 16 characters. |
| `GOOGLE_CLIENT_ID` | For Google sign-in | Must match the client id used in the browser. |
| `MS_CLIENT_ID` | For Microsoft sign-in | Azure app (client) id. |
| `MS_TENANT_ID` | For Microsoft sign-in | Azure tenant id. |
| `ADMIN_EMAILS` | For admin features | Comma-separated emails of admins (case-insensitive). Read on every request and never stored; edit and restart to change. An email counts only if the provider verified it (always true for Google); for Microsoft work accounts only when `MS_TENANT_ID` is your own tenant id, not `common`. |
| `PORT` | No | Defaults to `5000`. |
| `CORS_ORIGINS` | Recommended in production | Comma-separated list of exact origins allowed to call the API from a browser, for example `https://app.example.com`. When unset every origin is allowed (convenient in development). Requests without an `Origin` header (the command line, scripts) are never affected. |
| `TRUST_PROXY` | Behind a proxy | Number of reverse proxies in front of the server (for example `1`), so rate limits use the real client address. Leave unset when the server is reached directly. |
| `RATE_LIMIT_DISABLED` | No | Set to `1` to turn rate limiting off (the test suites do this). |

### Client environment (`client/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | No | API base URL. Defaults to `http://localhost:5000`. |
| `VITE_GOOGLE_CLIENT_ID` | For Google sign-in | Same value as the server's `GOOGLE_CLIENT_ID`. |
| `VITE_MS_CLIENT_ID` | For Microsoft sign-in | Same value as the server's `MS_CLIENT_ID`. |
| `VITE_MS_TENANT_ID` | For Microsoft sign-in | Same value as the server's `MS_TENANT_ID`. |

## Run in development

```bash
# terminal 1
cd server && npm run dev      # http://localhost:5000

# terminal 2
cd client && npm run dev      # http://localhost:5173
```

## Build

```bash
cd server && npm run build && npm start
cd client && npm run build && npm run preview
```

The server also ships a `vercel.json` for deployment on Vercel. Vercel invokes the Express handler exported by `server/src/api.ts`; `server/src/index.ts` starts the local HTTP server.

## API

All routes except sign-in need `Authorization: Bearer <session token>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/google` | Exchange a Google ID token for a session token |
| POST | `/api/auth/microsoft` | Exchange a Microsoft ID token for a session token |
| GET | `/api/auth/me` | Current user (`authMethod` is `session` or `token`) |

The earlier `/api/sprites` library routes were removed in Phase 5.

## Projects, folders and icons API

Every route needs `Authorization: Bearer <session token>`. Errors are `{ "error": "message" }` (validation errors also carry `details`). A private project of another user answers `404`, as if it did not exist; a project you can see but not change answers `403`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | List (query: `scope` all/mine/public, `status`, `purpose`, `search`, `sort`, `page`, `limit`) with icon counts, sample icons and your access flags |
| POST | `/api/projects` | Create (`name`, `description`, `prefix`, `color`, `purpose` sprite/font, `visibility`) |
| GET / PATCH / DELETE | `/api/projects/:projectId` | Detail with folder and trash counts; update; delete with everything in it (owner or admin) |
| POST | `/api/projects/:projectId/duplicate` | Copy a project you can see into a new private one you own |
| GET / POST | `/api/projects/:projectId/folders` | List folders with icon counts; create (`name`, `parentId`) |
| PATCH / DELETE | `/api/folders/:folderId` | Rename; delete (icons move to the trash) |
| POST | `/api/folders/:folderId/move` | Move (`parentId`, `orderIndex`); never into itself or a subfolder |
| GET | `/api/projects/:projectId/icons` | List (query: `folderId` or `root`, `includeSubfolders`, `search`, `tag`, `trash`, `sort`, `page`, `limit`, `svg`) |
| POST | `/api/projects/:projectId/icons/upload` | Multipart field `files` (SVG and ZIP) plus `folderId`, `strategy` rename/replace/skip, `optimize`, `tags` |
| POST | `/api/projects/:projectId/icons/paste` | Add one icon from SVG code |
| POST | `/api/projects/:projectId/icons/copy` | Copy icons from another project you can see |
| POST | `/api/projects/:projectId/icons/download` | One SVG, or a ZIP for several (`iconIds`) |
| POST | `/api/projects/:projectId/icons/batch/{move,tag,delete,restore,optimize}` | Batch actions; ids from other projects are ignored |
| DELETE | `/api/projects/:projectId/icons/trash` | Empty the trash |
| GET | `/api/icons/search?q=` | Search icons across the projects you can see |
| GET / PATCH / DELETE | `/api/icons/:iconId` | Detail with versions; edit (`name`, `folderId`, `tags`, `codepoint`, `rawSvg`); trash (`?permanent=true` for one already in the trash) |
| GET | `/api/icons/:iconId/download` | The SVG as an attachment |
| POST | `/api/icons/:iconId/optimize`, `/restore` | Optimize; take out of the trash |
| GET / POST | `/api/icons/:iconId/versions`, `/versions/:versionId/restore` | History (newest 20 kept); restore an earlier state |
| GET | `/api/projects/:projectId/export` | The project as a ZIP (`project.json` plus the SVGs; not the trash or saved versions) |
| POST | `/api/projects/import` | Multipart field `file`: create a new private project from an export ZIP. Every SVG is cleaned again; problems are listed, not fatal |
| GET | `/api/projects/:projectId/sprite` | The icons compiled into one SVG sprite (`?folderId=` for a folder or `root`); header `X-Sprite-Symbols` |

### Icon fonts

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/:projectId/font/build` | Build a font and return a preview: `css`, a small WOFF2 (`preview.base64`), the class and character of every icon, warnings and file sizes. Body: `scope` all/folder/selected (`folderId`, `iconIds`), `formats`, `fontName`, `prefix`, `baseClass` (optional: the stylesheet then needs `class="base prefix-name"`), `startCodepoint` (E000 to F8FF), `fontHeight`, `descent`, `normalize`. Anyone who can see the project may build; only editors get new characters saved on the icons |
| POST | `/api/projects/:projectId/font/download` | The same build as a ZIP. A download by someone who can edit the project is also kept in the build history |
| GET | `/api/projects/:projectId/font/builds` | The build history: kept packages with a version number (v1, v2, ... per project, never reused), newest first (at most 20 per project) |
| GET | `/api/projects/:projectId/font/builds/:buildId/download` | A kept package again |
| DELETE | `/api/projects/:projectId/font/builds/:buildId` | Remove a kept package (editors) |
| POST | `/api/projects/:projectId/sprite/builds` | Keep a sprite ZIP the browser built (editors; multipart `bundle` up to 12 MB, `mode` symbol/stack/css, `iconCount`) |
| GET | `/api/projects/:projectId/sprite/builds` | The sprite build history, newest first with version numbers (at most 20 per project) |
| GET | `/api/projects/:projectId/sprite/builds/:buildId/download` | A kept sprite ZIP again |
| DELETE | `/api/projects/:projectId/sprite/builds/:buildId` | Remove a kept sprite ZIP (editors) |
| POST | `/api/projects/:projectId/icons/import-font` | Multipart: `font` (TTF, OTF, WOFF, WOFF2 or SVG font, up to 8 MB), optional `mapping` (CSS or JSON that names the characters), `folderId`, `strategy`, `optimize`, `privateUseOnly` (default true), `dryRun` (only report what is in the font) |

At most 1000 icons per font. An icon's character is four hex digits from E000 to F8FF (the Private Use Area); the Font section's "Stable Unicode codepoints mapping" table lets editors change it, and the font is rebuilt with the new value. Strokes, gradients and text do not convert cleanly to a font and are listed as warnings. Builds run in a temporary folder that is removed afterwards. Only the ZIPs editors download are kept (the font build history, last 20, each under 12 MB) and they go away with the project.

### Admin and API tokens

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/users` | Users with project, icon and active token counts (`search`, `page`, `limit`) |
| DELETE | `/api/admin/users/:userId` | Delete a user and revoke their tokens; body `{ "transferTo": userId }` hands their projects over, otherwise they are deleted. You cannot delete yourself |
| POST | `/api/admin/projects/:projectId/transfer` | Body `{ "userId" }`: move the project to another owner |
| GET / POST | `/api/tokens` | List your tokens (never the secret); create one (`name`; the secret is returned once). At most 10 active |
| DELETE | `/api/tokens/:tokenId` | Revoke (immediate and permanent) |

## MCP server

The backend exposes a stateless Streamable HTTP MCP endpoint at `https://<your-api-host>/mcp`. It supports both current MCP clients and the earlier initialization handshake. Modern `tools/list` responses include explicit cache hints for the static tool definitions. Every request requires `Authorization: Bearer <personal-api-token>`. Create a read-only token in the app's Settings → API tokens section, then configure your MCP client with that endpoint URL and bearer token. Keep the token private; it is shown once and can be revoked from Settings.

Available tools are `list_projects`, `search_icons`, `list_project_icons`, `get_icon`, and `get_project_sprite`. They only return projects and icons the token owner may view. Write-scoped tokens are accepted but the MCP tools currently remain read-only. The endpoint is sessionless and returns JSON, making it suitable for serverless deployments such as the included Vercel setup.

To deploy, deploy `server/` as the Vercel project root (the existing `server/vercel.json` routes `/mcp` through the Express handler), set the server environment variables documented above, then use the deployed API domain plus `/mcp` in your MCP client. For browser-originated MCP calls, add the exact trusted site origin to `CORS_ORIGINS`; an `Origin` header is rejected when it is not explicitly allowlisted. Server-to-server MCP clients generally do not send an `Origin` header. After deployment, initialize an MCP connection and call `tools/list` to confirm the endpoint responds. Never put a personal token in public frontend source or in the URL.

Admin routes need an admin **session**. A token (`Authorization: Bearer isv_…`) works for everything else a signed-in user can do, but it never has admin rights and cannot manage tokens. Only a hash of each token is stored.

Limits: 1 MB per SVG, 200 files and 25 MB per file per upload request, 500 SVGs and 50 MB unpacked per ZIP, 1000 icons per upload, 500 ids per batch call. Uploaded SVGs are cleaned (scripts, event handlers, images, filters, external links and XML entities are removed; `<style>` rules are inlined first) and must be well-formed XML.

## Data model

- `users`: one per (provider, providerId).
- `projects`: owner, name, description, prefix, colour, `purpose` (`sprite` or `font`, fixed at creation), `visibility` (`public` or `private`), `isArchived`, `uncategorizedName` (what the sidebar calls the icons in no folder; empty means Uncategorized).
- `folders`: nested through `parentId` (null = project root), ordered by `orderIndex`.
- `icons`: one SVG per document (markup stored in the database), `slug` unique per project among active icons, `codepoint` unique per project among active icons that have one, soft delete through `deletedAt`.
- `icon_versions`: earlier states of an icon, each with its own markup.
- `sprite_builds`: the sprite ZIPs editors downloaded from the Sprite Builder (project, who, version, architecture, symbol count, size and the ZIP), at most 20 per project; `spriteBuildCount` on the project hands out the version numbers.
- `font_builds`: the font packages editors downloaded (project, who, version, font name, icon count, formats, size and the ZIP), at most 20 per project. The project's `fontBuildCount` hands out the version numbers.
- `api_tokens`: owner, name, a SHA-256 hash of the token (never the token), its first characters for display, `lastUsedAt`, `revokedAt`.

Admins are not stored: a user is an admin when their email is in `ADMIN_EMAILS`.

## Command line

`cli/` holds `iconvault`, a dependency-free Node (18+) tool that uses the API with a personal token:

```bash
node cli/bin/iconvault.mjs login --url http://localhost:5000   # paste a token from the web app (API tokens)
node cli/bin/iconvault.mjs projects
node cli/bin/iconvault.mjs upload "Feather" ./icons            # .svg and .zip files; folders are searched
node cli/bin/iconvault.mjs sprite "Feather" --out sprite.svg
node cli/bin/iconvault.mjs export "Feather" --out feather.zip
node cli/bin/iconvault.mjs import feather.zip
```

`iconvault help` lists everything. For CI, set `ICONVAULT_URL` and `ICONVAULT_TOKEN` instead of running `login`. `npm link` inside `cli/` installs the `iconvault` command. Exit code 0 is success, 1 an error, 2 some files could not be added.

## Maintenance scripts

Scripts live in `server/src/scripts/` (`backup-db.ts`, `drop-legacy-sprites.ts`). Run them with `npm run <name>` from `server/`.

- `npm run backup:db` (in `server/`) dumps every collection to `backups/<timestamp>/` at the project root as MongoDB Extended JSON. The folder is git-ignored because it contains user emails and icon data.
- `npm run cutover:drop-legacy` (in `server/`) removes the old `sprites` and `sprite_versions` collections. It only lists what would go unless you add `-- --confirm`; it was run once at the Phase 5 cutover.

## Security notes

- Sign-in uses Google or Microsoft only; there are no passwords. Sessions are signed tokens kept in the browser's local storage, so a script injected into the page could read one: the interface never inserts untrusted markup (uploaded SVGs are cleaned on the server and shown through a safe inline preview).
- Responses carry `nosniff`, frame, referrer and permissions headers, and nothing under `/api` is cached. Downloads add a restrictive content policy.
- Rate limits (per address for sign-in, 30 attempts per 15 minutes, and 1200 requests per minute overall; per credential for builds, imports, exports and uploads, 40 per minute). They live in this process, so behind several servers use a shared store instead.
- Uploaded SVGs, ZIPs, fonts and export archives are validated and size-limited; SVGs are cleaned again whatever their source. API tokens are stored as hashes and never carry admin rights.
- `npm audit` reports 0 vulnerabilities for `server/` and `client/` at the time of Phase 8; run it again before each release.

## Checks

| Command | Where | What it does |
|---|---|---|
| `npm run typecheck` | `server/` and `client/` | TypeScript check without emitting files |
| `npm test` | `server/` | Unit and smoke tests (server boots without a database, auth gates, sessions, admin rule, permissions, validation, error mapping). No database or network needed |
| `npm run test:db` | `server/` | Model tests against a throwaway database on your cluster, dropped afterwards. Needs `MONGODB_URI` |
| `npm run build` | `server/` and `client/` | Production build |
| `npm test` | `client/` | Component, theme, contrast and API-client tests (Vitest and Testing Library). No server needed |
| `npm test` | `cli/` | Command line tests against a mock of the API. No server or network needed |
| `npm run lint` | `client/` | ESLint. Currently clean |
