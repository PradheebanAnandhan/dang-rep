# DANY Portfolio

Static portfolio site. Deployed on Vercel (no build step; output directory is the repo root).

## Portfolios

One site, several portfolios. Each has its own link to send when applying, and its own theme:

| Link | Portfolio | Theme |
|---|---|---|
| `/` and `/designer` | Designer (the first one is the main link) | Light |
| `/video-editor` | Video Editor | Dark |
| `/digital-marketing` | Digital Marketing | Red & white |
| `/developer` | Developer | Midnight |

Visitors can switch between portfolios with the switcher at the top. Everything on the site (portfolios,
projects, notes, dock links) lives in `content.js`. Edit it at `/admin` rather than by hand.

## Admin panel (`/admin`)

Publishing from the admin commits `content.js` (and any uploaded files in `assets/uploads/`) to GitHub
through `api/admin.js`; Vercel redeploys on that commit, so changes go live in about a minute.
Every publish is a commit, so the git history is the undo button.

### One-time setup

1. The Vercel project must deploy from the GitHub repo (Git integration), so a new commit triggers a deploy.
2. Create a GitHub token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Repository access: only the repo Vercel deploys from. Permissions: **Contents: Read and write**.
   Note its expiry date; the admin stops publishing when it expires.
3. In Vercel → Project → Settings → Environment Variables (Production), add:
   - `ADMIN_PASSWORD`: a long password. It is the only lock on the admin.
   - `GITHUB_TOKEN`: the token from step 2.
   - `GITHUB_REPO`: `owner/name` of that repo.
   - `GITHUB_BRANCH`: only if it isn't `main`.
4. Redeploy once so the function picks up the variables.

### Limits

- Uploads go through a Vercel function, so each file must be under 3.3 MB. Pictures are resized and
  compressed in the browser first. Long videos belong on YouTube/Vimeo/Drive/Instagram: add them as links.
- Two people publishing at once: the second gets a "changed somewhere else" message and has to reload.

## Local development

```bash
node dev/server.mjs
```

Serves the site at http://127.0.0.1:3000 with the same routing as Vercel. The admin works too (password
`dev`): instead of GitHub, publishing writes `content.js` and `assets/uploads/` straight into this folder.

```bash
node --test dev/api.test.mjs
```

Tests the admin API against a temporary copy of the site. `dev/` is not deployed (`.vercelignore`).
