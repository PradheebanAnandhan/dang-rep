# DANY Portfolio

Static portfolio site. Deployed on Vercel (no build step; output directory is the repo root).

## Two portfolios, one switch

The toggle at the top of the page flips between the **Designer** portfolio (light theme) and the
**Marketing** portfolio (black-and-white theme). All content lives in the script block of
`index.html`: `DESIGNER_PROJECTS` / `DESIGNER_NOTES` and `MARKETING_PROJECTS` / `MARKETING_NOTES`.

- Share the marketing side directly with `?mode=marketing` (e.g. `https://<site>/?mode=marketing`).
- The visitor's last choice is remembered in their browser.
- Deep links like `#ruha` or `#meta-ads` switch to whichever portfolio holds that project.
