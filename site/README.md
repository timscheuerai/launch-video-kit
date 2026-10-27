# Comparison microsite

A static site (no build step, no framework) for Cloudflare Pages: `/compare` is an
interactive, sortable table of launch-video-kit against shipvideo, Waymark, InVideo AI,
Arcade, Tella and lemomo-ai/lemo-opuscar, sourced from `STRATEGY-2026-10-23.md` section 1 and
`docs/costs.md`. `/` redirects straight to `/compare/`.

Turns the strategy doc's differentiation table from a README section into a shareable,
submittable page for `yihui-dev/awesome-opus5-5-videos` and Show HN.

## Deploy

```bash
npx wrangler pages deploy site --project-name=launch-video-kit-compare
```

First run creates the Pages project on your Cloudflare account (free tier - unlimited
requests, 500 builds/month) and prints the `*.pages.dev` URL. Re-run the same command to
redeploy after an edit; no dashboard click needed.

To map a custom domain or connect this to automatic deploys on `git push`, use the
Cloudflare dashboard's Pages → Create project → Connect to Git flow instead, pointed at this
repo with `site` as the build output directory and no build command.
