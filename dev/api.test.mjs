// node --test dev/api.test.mjs   (runs /api/admin through the dev server against a temp copy of the site)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startDevServer } from "./server.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const blobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const readContent = (root) => {
  const t = fs.readFileSync(path.join(root, "content.js"), "utf8");
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
};
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let root, srv;
const call = async (method, body, password = "dev") => {
  const r = await fetch(srv.url + "/api/admin", {
    method,
    headers: { ...(password !== null && { Authorization: `Bearer ${password}` }), "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const get = (p) => fetch(srv.url + p).then(async (r) => ({ status: r.status, text: await r.text() }));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-"));
  fs.cpSync(REPO, root, { recursive: true, filter: (src) => ![".git", "dev"].includes(path.relative(REPO, src).split(path.sep)[0]) });
  srv = await startDevServer({ root, port: 0, password: "dev" });
});
after(async () => {
  await srv?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejects missing and wrong passwords", async () => {
  assert.equal((await call("GET", undefined, null)).status, 401);
  const wrong = await call("GET", undefined, "nope");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, "Wrong password.");
});

test("GET returns the content and its git blob sha", async () => {
  const { status, json } = await call("GET");
  assert.equal(status, 200);
  assert.ok(json.content.roles.length >= 1);
  assert.match(json.contentSha, /^[0-9a-f]{40}$/);
  assert.equal(json.contentSha, blobSha(fs.readFileSync(path.join(root, "content.js"))));
});

test("upload, publish, conflict", async () => {
  const up = await call("POST", { action: "upload", type: "image/png", data: PNG.toString("base64") });
  assert.equal(up.status, 200);
  assert.match(up.json.path, /^assets\/uploads\/[0-9a-f]{16}\.png$/);
  assert.match(up.json.sha, /^[0-9a-f]{40}$/);
  const again = await call("POST", { action: "upload", type: "image/png", data: PNG.toString("base64") });
  assert.equal(again.json.path, up.json.path);

  const { json: loaded } = await call("GET");
  const content = loaded.content;
  content.profile.nickname = "Danny Test";
  content.projects[0].media.push({ type: "image", src: up.json.path, w: 1, h: 1, alt: "dot" });
  const pub = await call("POST", { action: "publish", content, baseSha: loaded.contentSha, files: [up.json] });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.match(pub.json.commit, /^[0-9a-f]{40}$/);

  const onDisk = readContent(root);
  assert.equal(onDisk.profile.nickname, "Danny Test");
  assert.equal(onDisk.updatedAt, pub.json.updatedAt);
  assert.ok(fs.readFileSync(path.join(root, "content.js"), "utf8").startsWith("// Portfolio content."));
  assert.deepEqual(fs.readFileSync(path.join(root, up.json.path)), PNG);
  assert.equal((await call("GET")).json.contentSha, pub.json.contentSha);

  const stale = await call("POST", { action: "publish", content, baseSha: loaded.contentSha, files: [] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "conflict");
});

test("rejects bad uploads", async () => {
  assert.equal((await call("POST", { action: "upload", type: "image/svg+xml", data: "PHN2Zy8+" })).status, 400);
  assert.equal((await call("POST", { action: "upload", type: "image/png", data: "" })).status, 400);
  const big = Buffer.alloc(3_350_000).toString("base64");
  assert.equal((await call("POST", { action: "upload", type: "video/mp4", data: big })).status, 413);
});

test("rejects invalid content and files", async () => {
  const { json } = await call("GET");
  const base = json.content;
  const bad = [
    (c) => { c.roles = []; },
    (c) => { c.roles.push({ ...c.roles[0] }); },
    (c) => { c.roles[0].id = "admin"; },
    (c) => { c.roles[0].id = "Not A Slug"; },
    (c) => { c.roles[0].theme = "neon"; },
    (c) => { c.projects[0].title = " "; },
    (c) => { c.projects[1].id = c.projects[0].id; },
    (c) => { c.notes[0].roles = "designer"; },
    (c) => { delete c.links; },
  ];
  for (const mutate of bad) {
    const c = structuredClone(base);
    mutate(c);
    const r = await call("POST", { action: "publish", content: c, baseSha: json.contentSha, files: [] });
    assert.equal(r.status, 400, mutate.toString());
    assert.ok(r.json.error);
  }
  for (const f of [{ path: "assets/uploads/../../index.html", sha: "a".repeat(40) }, { path: "assets/uploads/0123456789abcdef.png", sha: "nope" }, { path: "content.js", sha: "a".repeat(40) }]) {
    const r = await call("POST", { action: "publish", content: base, baseSha: json.contentSha, files: [f] });
    assert.equal(r.status, 400, f.path);
  }
  assert.equal((await call("PUT", { action: "publish" })).status, 405);
  assert.equal((await call("POST", { action: "nope" })).status, 400);
});

test("static routing mirrors vercel.json", async () => {
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal((await get("/")).text, index);
  assert.equal((await get("/designer")).text, index);
  assert.equal((await get("/content.js")).status, 200);
  if (fs.existsSync(path.join(root, "admin.html"))) assert.match((await get("/admin")).text, /<title>/);
  assert.equal((await get("/nope/deeper")).status, 404);
  assert.equal((await get("/%2e%2e/%2e%2e/etc/passwd")).status, 404);
  const range = await fetch(srv.url + "/content.js", { headers: { Range: "bytes=0-9" } });
  assert.equal(range.status, 206);
  assert.equal((await range.text()).length, 10);
});
