// Serves the site's pages ("/" and "/designer", "/video-editor"…; see vercel.json). The page is app.html;
// this only fills in the title, description and link-preview tags for the portfolio in the URL, because
// WhatsApp, LinkedIn & co. read those without running any JavaScript. Unknown portfolio links get 404.html.
const fs = require("fs");
const path = require("path");

const ROOT = process.env.SITE_ROOT || process.cwd();
const THEME_COLORS = { light: "#f4f4f4", dark: "#0f0f12", midnight: "#0d1838", red: "#b41d30" }; // as in app.html
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const attr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function setMeta(html, key, value) {
  const re = new RegExp(`(<meta (?:name|property)="${key}" content=")[^"]*(")`);
  return html.replace(re, (_, a, b) => a + attr(value) + b);
}

function render(html, content, role, origin) {
  const p = { name: "", nickname: "", ...content.profile };
  const who = p.nickname || p.name || "Portfolio";
  const tagline = role.tagline || content.roles[0].tagline || "";
  const theme = THEME_COLORS[role.theme] ? role.theme : "light";
  const title = `${who} Here (${role.label} Portfolio)`;
  const url = origin + (role.id === content.roles[0].id ? "/" : "/" + role.id);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`);
  html = setMeta(html, "description", `Hi there, ${who}${p.name && p.nickname ? ` (${p.name})` : ""} here: ${tagline} Check out my ${role.label.toLowerCase()} portfolio.`);
  html = setMeta(html, "og:title", `${who} · ${role.label}`);
  html = setMeta(html, "og:description", tagline ? tagline.charAt(0).toUpperCase() + tagline.slice(1) : `${role.label} portfolio`);
  html = setMeta(html, "og:image", `${origin}/assets/og/og-${theme}.jpg`);
  html = setMeta(html, "og:url", url);
  html = setMeta(html, "theme-color", THEME_COLORS[theme]);
  return html.replace("<html lang=\"en\">", `<html lang="en" data-theme="${theme}">`);
}

module.exports = function handler(req, res) {
  let html = "";
  try {
    html = read("app.html");
    const text = read("content.js");
    const content = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const id = String((req.query && req.query.role) || new URL(req.url, "http://x").searchParams.get("role") || "");
    const role = id ? content.roles.find((r) => r.id === id) : content.roles[0];
    if (!role) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      return res.end(read("404.html"));
    }
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || (/^(localhost|127\.)/.test(host) ? "http" : "https");
    html = render(html, content, role, `${proto}://${host}`);
  } catch (err) {
    console.error(err); // still serve the plain page: the site must never go down over a preview tag
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // each deploy (every publish) gets a fresh cache, so the CDN can keep this for a day
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=86400");
  res.end(html);
};
