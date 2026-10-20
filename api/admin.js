// /api/admin: the admin panel's backend. Reads content.js from GitHub, uploads files as git blobs and
// publishes by committing content.js (+ uploads) in one commit; Vercel redeploys on the push.
// Env: ADMIN_PASSWORD, GITHUB_TOKEN (fine-grained, Contents: read & write), GITHUB_REPO (owner/name),
//      GITHUB_BRANCH (default main), GITHUB_API_URL (default https://api.github.com; the dev server overrides it).
const crypto = require("crypto");

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set(["admin", "api", "assets", "content", "dev", "index"]);
const THEMES = ["light", "dark", "midnight", "red"]; // must match THEMES in index.html
const TYPES = {
  "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf",
};
const MAX_UPLOAD = 3300000; // Vercel rejects request bodies over 4.5 MB; base64 adds a third
const UPLOAD_PATH = /^assets\/uploads\/[0-9a-f]{16}\.(webp|jpg|png|gif|avif|mp4|webm|pdf)$/;
const HEADER = "// Portfolio content. Edit it at /admin. Hand edits must keep the object below valid JSON.\n";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const gitBlobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseContent = (text) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    Object.assign(this, { status }, extra);
  }
}

async function gh(cfg, method, path, body) {
  const res = await fetch(`${cfg.api}/repos/${cfg.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "portfolio-admin",
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `GitHub: ${res.status} ${data.message || res.statusText}`, { gh: res.status });
  return data;
}

async function readContent(cfg, ref) {
  let file;
  try {
    file = await gh(cfg, "GET", `/contents/content.js?ref=${encodeURIComponent(ref)}`);
  } catch (e) {
    if (e.gh === 404) throw new HttpError(502, `content.js was not found on branch "${cfg.branch}" of ${cfg.repo}.`);
    throw e;
  }
  // the contents API leaves out files over 1 MB; the blobs API doesn't
  if (file.encoding !== "base64") file = await gh(cfg, "GET", `/git/blobs/${file.sha}`);
  return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
}

function validate(c) {
  const fail = (msg) => { throw new HttpError(400, msg); };
  if (!c || typeof c !== "object" || Array.isArray(c)) fail("The content is missing.");
  if (!Array.isArray(c.roles) || !c.roles.length) fail("Add at least one portfolio.");
  for (const k of ["projects", "notes", "links"]) if (!Array.isArray(c[k])) fail(`The ${k} list is missing.`);
  const roleIds = new Set();
  c.roles.forEach((r, i) => {
    if (!r || typeof r.label !== "string" || !r.label.trim()) fail(`Portfolio #${i + 1} needs a name.`);
    if (typeof r.id !== "string" || !SLUG.test(r.id)) fail(`Portfolio "${r.label}" has an invalid link name. Use lowercase letters, numbers and dashes.`);
    if (RESERVED.has(r.id)) fail(`"${r.id}" is reserved. Pick another link name for portfolio "${r.label}".`);
    if (roleIds.has(r.id)) fail(`Two portfolios use the link name "${r.id}".`);
    if (r.theme !== undefined && !THEMES.includes(r.theme)) fail(`Portfolio "${r.label}" has an unknown theme.`);
    roleIds.add(r.id);
  });
  const check = (list, what, needsTitle) => {
    const ids = new Set();
    list.forEach((it, i) => {
      if (!it || typeof it !== "object") fail(`${what} #${i + 1} is broken.`);
      const name = it.title || it.type || `#${i + 1}`;
      if (!Array.isArray(it.roles) || !it.roles.every((x) => typeof x === "string")) fail(`${what} "${name}" has a broken portfolio list.`);
      if (!needsTitle) {
        if (typeof it.url !== "string" || typeof it.type !== "string") fail(`${what} "${name}" needs a type and a URL.`);
        return;
      }
      if (typeof it.title !== "string" || !it.title.trim()) fail(`${what} #${i + 1} needs a title.`);
      if (typeof it.id !== "string" || !SLUG.test(it.id)) fail(`${what} "${it.title}" has an invalid id.`);
      if (ids.has(it.id)) fail(`Two ${what.toLowerCase()}s use the id "${it.id}".`);
      ids.add(it.id);
    });
  };
  check(c.projects, "Project", true);
  check(c.notes, "Note", true);
  check(c.links, "Link", false);
}

async function upload(cfg, { type, data }) {
  const ext = TYPES[type];
  if (!ext) throw new HttpError(400, "That file type can't be uploaded. Use JPG, PNG, WebP, GIF, AVIF, MP4, WebM or PDF.");
  if (typeof data !== "string" || !data) throw new HttpError(400, "The file is empty.");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new HttpError(400, "The file is empty.");
  if (bytes.length > MAX_UPLOAD) {
    throw new HttpError(413, "That file is too big to upload here (max 3.3 MB). For videos, put them on YouTube or Vimeo and add the link instead.");
  }
  const blob = await gh(cfg, "POST", "/git/blobs", { content: bytes.toString("base64"), encoding: "base64" });
  return { path: `assets/uploads/${sha256(bytes).toString("hex").slice(0, 16)}.${ext}`, sha: blob.sha };
}

async function publish(cfg, { content, baseSha, files = [], message }) {
  validate(content);
  const valid = (f) => f && UPLOAD_PATH.test(f.path) && /^[0-9a-f]{40}$/.test(f.sha);
  if (!Array.isArray(files) || files.length > 200 || !files.every(valid)) {
    throw new HttpError(400, "Some uploaded files are invalid. Remove them and upload again.");
  }
  const conflict = () => new HttpError(409, "Your portfolio was changed somewhere else (another tab or device) after you opened the admin. Reload to get the latest version.", { code: "conflict" });

  const head = (await gh(cfg, "GET", `/git/ref/heads/${encodeURIComponent(cfg.branch)}`)).object.sha;
  const commit = await gh(cfg, "GET", `/git/commits/${head}`);
  if ((await gh(cfg, "GET", `/contents/content.js?ref=${head}`)).sha !== baseSha) throw conflict();

  content.updatedAt = new Date().toISOString();
  const text = `${HEADER}window.CONTENT = ${JSON.stringify(content, null, 2)};\n`;
  const uploads = [...new Map(files.map((f) => [f.path, f.sha]))].map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha }));
  const tree = await gh(cfg, "POST", "/git/trees", {
    base_tree: commit.tree.sha,
    tree: [{ path: "content.js", mode: "100644", type: "blob", content: text }, ...uploads],
  });
  const msg = typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : "Update portfolio content from admin";
  const next = await gh(cfg, "POST", "/git/commits", { message: msg, tree: tree.sha, parents: [head] });
  try {
    await gh(cfg, "PATCH", `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, { sha: next.sha, force: false });
  } catch (e) {
    if (e.gh === 422) throw conflict(); // someone pushed in between: not a fast-forward
    throw e;
  }
  return { commit: next.sha, contentSha: gitBlobSha(Buffer.from(text)), updatedAt: content.updatedAt };
}

module.exports = async function handler(req, res) {
  const e = process.env;
  const cfg = {
    token: e.GITHUB_TOKEN, repo: e.GITHUB_REPO, branch: e.GITHUB_BRANCH || "main",
    api: (e.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
  try {
    if (!e.ADMIN_PASSWORD) throw new HttpError(503, "Admin is not configured yet.");
    const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!crypto.timingSafeEqual(sha256(given), sha256(e.ADMIN_PASSWORD))) {
      await sleep(700); // slows down password guessing
      throw new HttpError(401, "Wrong password.");
    }
    const missing = ["GITHUB_TOKEN", "GITHUB_REPO"].filter((k) => !e[k]);
    if (missing.length) throw new HttpError(503, `Admin is missing these settings on Vercel: ${missing.join(", ")}.`);

    if (req.method === "GET") {
      const { text, sha } = await readContent(cfg, cfg.branch);
      let content;
      try {
        content = parseContent(text);
      } catch {
        throw new HttpError(502, "content.js on GitHub is not valid JSON. Fix it by hand, then reload.");
      }
      return res.status(200).json({ content, contentSha: sha, updatedAt: content.updatedAt || null });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      throw new HttpError(405, "Method not allowed.");
    }
    let body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body || "{}"); } catch { throw new HttpError(400, "Bad request."); }
    }
    if (body.action === "upload") return res.status(200).json(await upload(cfg, body));
    if (body.action === "publish") return res.status(200).json(await publish(cfg, body));
    throw new HttpError(400, "Unknown action.");
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "Something went wrong on the server." : err.message, ...(err.code && { code: err.code }) });
  }
};
