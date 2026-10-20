// Local dev server: serves the site with vercel.json's routing and runs the real /api/admin handler
// against a mock GitHub that reads and writes this folder, so "Publish" in /admin edits content.js
// and assets/uploads/ on disk. Not deployed (.vercelignore).
//   node dev/server.mjs [--root DIR] [--port 3000] [--password dev]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HANDLER = path.join(REPO, "api", "admin.js");
const require = createRequire(import.meta.url);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".md": "text/plain; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".pdf": "application/pdf", ".woff2": "font/woff2",
};

const gitBlobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const randomSha = () => crypto.randomBytes(20).toString("hex");
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// absolute path for rel inside root, or null if it escapes
const inside = (root, rel) => {
  const p = path.resolve(root, rel);
  return p.startsWith(root + path.sep) ? p : null;
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};
const sendJSON = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

/* ---------------------------------------------------------------- static files */
// vercel.json: cleanUrls, "/" → index.html, and /:role([a-z0-9-]+) → index.html when no file matches
function resolveStatic(root, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel === "/") return path.join(root, "index.html");
  const p = !rel.includes("\0") && inside(root, "." + rel);
  if (!p) return null;
  if (isFile(p)) return p;
  if (isFile(p + ".html")) return p + ".html";
  if (/^\/[a-z0-9-]+$/.test(rel)) return path.join(root, "index.html");
  return null;
}

function sendFile(req, res, file) {
  const size = fs.statSync(file).size;
  const headers = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) { // video seeking
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return req.method === "HEAD" ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
}

/* ---------------------------------------------------------------- mock GitHub (backed by root on disk) */
function mockGitHub(root) {
  const blobs = new Map(); // sha -> Buffer
  const trees = new Map(); // sha -> [{ path, data: Buffer }] (changes on top of the disk)
  const commits = new Map(); // sha -> { tree, parents }
  let head = randomSha();
  commits.set(head, { tree: randomSha(), parents: [] });

  return http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer dev-token") return sendJSON(res, 401, { message: "Bad credentials" });
    const url = new URL(req.url, "http://x");
    const route = url.pathname.replace(/^\/repos\/local\/dev/, "");
    const body = req.method === "GET" ? {} : JSON.parse((await readBody(req)).toString("utf8") || "{}");
    let m;

    if (req.method === "GET" && route === "/contents/content.js") {
      const file = path.join(root, "content.js");
      if (!isFile(file)) return sendJSON(res, 404, { message: "Not Found" });
      const data = fs.readFileSync(file);
      return sendJSON(res, 200, { type: "file", encoding: "base64", content: data.toString("base64"), sha: gitBlobSha(data) });
    }
    if (req.method === "GET" && route === "/git/ref/heads/main") return sendJSON(res, 200, { ref: "refs/heads/main", object: { sha: head, type: "commit" } });
    if (req.method === "GET" && (m = route.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = commits.get(m[1]);
      return c ? sendJSON(res, 200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : sendJSON(res, 404, { message: "Not Found" });
    }
    if (req.method === "POST" && route === "/git/blobs") {
      const data = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      const sha = gitBlobSha(data);
      blobs.set(sha, data);
      return sendJSON(res, 201, { sha });
    }
    if (req.method === "POST" && route === "/git/trees") {
      const entries = [];
      for (const e of body.tree || []) {
        const data = e.content !== undefined ? Buffer.from(e.content, "utf8") : blobs.get(e.sha);
        if (!data) return sendJSON(res, 422, { message: `Invalid tree info: missing blob ${e.sha}` });
        entries.push({ path: e.path, data });
      }
      const sha = randomSha();
      trees.set(sha, entries);
      return sendJSON(res, 201, { sha });
    }
    if (req.method === "POST" && route === "/git/commits") {
      if (!trees.has(body.tree)) return sendJSON(res, 422, { message: "Tree not found" });
      const sha = randomSha();
      commits.set(sha, { tree: body.tree, parents: body.parents || [] });
      return sendJSON(res, 201, { sha });
    }
    if (req.method === "PATCH" && route === "/git/refs/heads/main") {
      const c = commits.get(body.sha);
      if (!c) return sendJSON(res, 422, { message: "Object does not exist" });
      if (!body.force && c.parents[0] !== head) return sendJSON(res, 422, { message: "Update is not a fast forward" });
      const entries = trees.get(c.tree) || [];
      if (entries.some((e) => !inside(root, e.path))) return sendJSON(res, 422, { message: "Bad path" });
      for (const e of entries) {
        const p = inside(root, e.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, e.data);
      }
      head = body.sha;
      return sendJSON(res, 200, { ref: "refs/heads/main", object: { sha: head, type: "commit" } });
    }
    sendJSON(res, 404, { message: `Mock GitHub has no route for ${req.method} ${route}` });
  });
}

/* ---------------------------------------------------------------- server */
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve(server.address().port));
});

export async function startDevServer({ root = REPO, port = 3000, password = process.env.ADMIN_PASSWORD || "dev" } = {}) {
  root = path.resolve(root);
  const gh = mockGitHub(root);
  const ghPort = await listen(gh, 0);
  const env = {
    ADMIN_PASSWORD: password, GITHUB_TOKEN: "dev-token", GITHUB_REPO: "local/dev",
    GITHUB_BRANCH: "main", GITHUB_API_URL: `http://127.0.0.1:${ghPort}`,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://x");
      if (pathname === "/api/admin") {
        const raw = await readBody(req);
        if (raw.length > 4.5e6) { // Vercel's request body limit
          res.writeHead(413, { "Content-Type": "text/plain" });
          return res.end("Request Entity Too Large");
        }
        const text = raw.toString("utf8");
        try {
          req.body = /json/.test(req.headers["content-type"] || "") && text ? JSON.parse(text) : text;
        } catch {
          return sendJSON(res, 400, { error: "Invalid JSON" });
        }
        res.status = (n) => ((res.statusCode = n), res);
        res.json = (obj) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(obj)), res);
        Object.assign(process.env, env);
        delete require.cache[HANDLER]; // pick up edits without a restart
        return await require(HANDLER)(req, res);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return sendJSON(res, 405, { error: "Method not allowed" });
      const file = resolveStatic(root, pathname);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      sendFile(req, res, file);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJSON(res, 500, { error: String(err.message || err) });
      else res.end();
    }
  });
  const actualPort = await listen(server, port);
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => Promise.all([server, gh].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const opts = { root: arg("root"), port: arg("port") === undefined ? undefined : +arg("port"), password: arg("password") };
  Object.keys(opts).forEach((k) => opts[k] === undefined && delete opts[k]);
  const { url } = await startDevServer(opts);
  console.log(`Portfolio: ${url}\nAdmin:     ${url}/admin  (password: ${opts.password || process.env.ADMIN_PASSWORD || "dev"})\nPublishing writes into ${path.resolve(opts.root || REPO)}`);
}
