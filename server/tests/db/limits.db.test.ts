// HTTP tests against a throwaway database for the account limits (projects, icons, folders), "sign out everywhere", and API token scopes and expiry.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import ApiToken from "../../src/models/ApiToken.js";
import { SVG, hasDatabase, startHarness, type TestUser } from "./harness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("limits, sign out everywhere, token scopes (HTTP, throwaway database)", { skip: hasDatabase ? false : "MONGODB_URI is not set" }, () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let ada: TestUser;

  before(async () => {
    h = await startHarness();
    ada = await h.makeUser("ada");
  });
  after(() => {
    delete process.env.MAX_PROJECTS_PER_USER;
    delete process.env.MAX_ICONS_PER_PROJECT;
    delete process.env.MAX_FOLDERS_PER_PROJECT;
    return h?.stop();
  });

  const newProject = (user: TestUser, name: string) => h.call(user.token, "POST", "/api/projects", { name, prefix: "ic", purpose: "sprite" });

  describe("limits", () => {
    it("stops a user at the project limit, and deleting one frees a place", async () => {
      process.env.MAX_PROJECTS_PER_USER = "2";
      const user = await h.makeUser("projects");
      const a = await newProject(user, "One");
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal((await newProject(user, "Two")).status, 201);
      const third = await newProject(user, "Three");
      assert.equal(third.status, 409);
      assert.match(third.body.error, /2 projects at most/);
      assert.equal((await h.call(user.token, "POST", `/api/projects/${a.body.id}/duplicate`)).status, 409);
      await h.call(user.token, "DELETE", `/api/projects/${a.body.id}`);
      assert.equal((await newProject(user, "Three")).status, 201);
      // Another user is not affected.
      assert.equal((await newProject(await h.makeUser("other"), "Mine")).status, 201);
      delete process.env.MAX_PROJECTS_PER_USER;
    });

    it("stops a project at the icon limit, counting the trash", async () => {
      process.env.MAX_ICONS_PER_PROJECT = "3";
      const project = (await newProject(ada, "Icons")).body;
      const paste = (name: string) => h.call(ada.token, "POST", `/api/projects/${project.id}/icons/paste`, { name, rawSvg: SVG() });
      for (const name of ["a", "b", "c"]) assert.equal((await paste(name)).status, 201);
      const over = await paste("d");
      assert.equal(over.status, 409);
      assert.match(over.body.error, /3 icons at most/);
      // A trashed icon still counts; emptying the trash frees the room.
      const list = await h.call(ada.token, "GET", `/api/projects/${project.id}/icons`);
      await h.call(ada.token, "DELETE", `/api/icons/${list.body.icons[0].id}`);
      assert.equal((await paste("e")).status, 409);
      await h.call(ada.token, "DELETE", `/api/projects/${project.id}/icons/trash`);
      assert.equal((await paste("e")).status, 201);
      delete process.env.MAX_ICONS_PER_PROJECT;
    });

    it("keeps concurrent bulk uploads within the icon limit", async () => {
      process.env.MAX_ICONS_PER_PROJECT = "3";
      const project = (await newProject(ada, "Concurrent icons")).body;
      const upload = (names: string[]) => {
        const data = new FormData();
        for (const name of names) data.append("files", new File([SVG()], `${name}.svg`, { type: "image/svg+xml" }));
        return h.call(ada.token, "POST", `/api/projects/${project.id}/icons/upload`, data);
      };

      const results = await Promise.all([upload(["one", "two"]), upload(["three", "four"])]);
      assert.ok(results.every((result) => result.status === 201), JSON.stringify(results.map((result) => result.body)));
      assert.equal(results.reduce((total, result) => total + result.body.created.length, 0), 3);
      assert.equal(results.reduce((total, result) => total + result.body.errors.length, 0), 1);
      delete process.env.MAX_ICONS_PER_PROJECT;
    });

    it("stops a project at the folder limit", async () => {
      process.env.MAX_FOLDERS_PER_PROJECT = "2";
      const project = (await newProject(ada, "Folders")).body;
      const make = (name: string) => h.call(ada.token, "POST", `/api/projects/${project.id}/folders`, { name });
      assert.equal((await make("a")).status, 201);
      assert.equal((await make("b")).status, 201);
      assert.equal((await make("c")).status, 409);
      delete process.env.MAX_FOLDERS_PER_PROJECT;
    });
  });

  describe("sign out everywhere", () => {
    it("ends other sessions at once, keeps the asking device signed in, and leaves other users alone", async () => {
      const user = await h.makeUser("sessions");
      const other = await h.makeUser("bystander");
      await sleep(1100); // a token's issue time has one-second precision
      assert.equal((await h.call(user.token, "GET", "/api/auth/me")).status, 200);
      const r = await h.call(user.token, "POST", "/api/auth/me/sign-out-everywhere");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(typeof r.body.token, "string");
      const old = await h.call(user.token, "GET", "/api/auth/me");
      assert.equal(old.status, 401);
      assert.match(old.body.error, /signed out/);
      assert.equal((await h.call(r.body.token, "GET", "/api/auth/me")).status, 200);
      assert.equal((await h.call(other.token, "GET", "/api/auth/me")).status, 200);
    });

    it("needs a sign-in and a real session, not an API token", async () => {
      assert.equal((await h.call(null, "POST", "/api/auth/me/sign-out-everywhere")).status, 401);
      const made = await h.call(ada.token, "POST", "/api/tokens", { name: "ci", scope: "write" });
      assert.equal((await h.call(made.body.token, "POST", "/api/auth/me/sign-out-everywhere")).status, 403);
    });

    it("does not revoke API tokens", async () => {
      const user = await h.makeUser("keeptokens");
      const made = await h.call(user.token, "POST", "/api/tokens", { name: "ci" });
      await sleep(1100);
      await h.call(user.token, "POST", "/api/auth/me/sign-out-everywhere");
      assert.equal((await h.call(made.body.token, "GET", "/api/auth/me")).status, 200);
    });
  });

  describe("API token scopes and expiry", () => {
    it("is read-only and lasts 90 days unless asked otherwise", async () => {
      const r = await h.call(ada.token, "POST", "/api/tokens", { name: "default" });
      assert.equal(r.status, 201);
      assert.equal(r.body.scope, "read");
      const days = (new Date(r.body.expiresAt).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 89 && days <= 90, String(days));
      const never = await h.call(ada.token, "POST", "/api/tokens", { name: "never", expiresInDays: null });
      assert.equal(never.body.expiresAt, null);
      assert.equal((await h.call(ada.token, "POST", "/api/tokens", { name: "bad", scope: "admin" })).status, 400);
      assert.equal((await h.call(ada.token, "POST", "/api/tokens", { name: "bad", expiresInDays: 1000 })).status, 400);
      assert.equal((await h.call(ada.token, "POST", "/api/tokens", { name: "bad", expiresInDays: 0 })).status, 400);
    });

    it("a read token reads and downloads but cannot change anything", async () => {
      const user = await h.makeUser("reader");
      const project = (await newProject(user, "Mine")).body;
      await h.call(user.token, "POST", `/api/projects/${project.id}/icons/paste`, { name: "dot", rawSvg: SVG() });
      const icons = (await h.call(user.token, "GET", `/api/projects/${project.id}/icons`)).body.icons;
      const read = (await h.call(user.token, "POST", "/api/tokens", { name: "ro", scope: "read" })).body.token as string;

      assert.equal((await h.call(read, "GET", `/api/projects/${project.id}/icons`)).status, 200);
      assert.equal((await h.call(read, "POST", `/api/projects/${project.id}/icons/download`, { iconIds: [icons[0].id] })).status, 200);
      for (const [method, path, body] of [
        ["POST", "/api/projects", { name: "New", prefix: "ic", purpose: "sprite" }],
        ["POST", `/api/projects/${project.id}/icons/paste`, { name: "x", rawSvg: SVG() }],
        ["PATCH", `/api/projects/${project.id}`, { name: "Renamed" }],
        ["DELETE", `/api/icons/${icons[0].id}`, undefined],
        ["DELETE", `/api/projects/${project.id}`, undefined],
      ] as const) {
        const r = await h.call(read, method, path, body);
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.match(r.body.error, /read-only/);
        assert.match(r.body.error, /read\/write API token/);
      }
      assert.equal((await h.call(user.token, "GET", `/api/projects/${project.id}`)).status, 200);
    });

    it("a write token can change data", async () => {
      const user = await h.makeUser("writer");
      const write = (await h.call(user.token, "POST", "/api/tokens", { name: "rw", scope: "write" })).body.token as string;
      assert.equal((await newProject({ ...user, token: write }, "ViaToken")).status, 201);
    });

    it("an expired token is refused, and a token without an expiry (older ones) keeps working", async () => {
      const user = await h.makeUser("expiry");
      const made = (await h.call(user.token, "POST", "/api/tokens", { name: "short", expiresInDays: 1 })).body;
      assert.equal((await h.call(made.token, "GET", "/api/auth/me")).status, 200);
      await ApiToken.updateOne({ _id: made.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await h.call(made.token, "GET", "/api/auth/me");
      assert.equal(expired.status, 401);
      assert.match(expired.body.error, /expired/);

      // A token written before scopes and expiry existed has neither field: it keeps full access.
      const legacy = (await h.call(user.token, "POST", "/api/tokens", { name: "old" })).body;
      await ApiToken.collection.updateOne({ _id: new (await import("mongoose")).default.Types.ObjectId(legacy.id) }, { $unset: { scope: "", expiresAt: "" } });
      assert.equal((await newProject({ ...user, token: legacy.token }, "Legacy")).status, 201);
      const listed = (await h.call(user.token, "GET", "/api/tokens")).body.tokens.find((t: { id: string }) => t.id === legacy.id);
      assert.equal(listed.scope, "write");
      assert.equal(listed.expiresAt, null);
    });
  });
});
