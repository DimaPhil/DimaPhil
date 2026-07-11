# Maintaining this profile

This repo is a GitHub **profile repo** (`DimaPhil/DimaPhil`): its `README.md`
renders on your profile page at <https://github.com/DimaPhil>.

Both the `README.md` and `assets/profile.svg` are **generated** — don't hand-edit
them. They come from two inputs:

- **`data.json`** — all text: identity, the neofetch-style rows (OS / Uptime /
  Kernel / …), GitHub stat numbers, contact links, and the *Selected systems*
  repo list.
- **`photo.jpg`** — the source portrait. A square photo works best; the near-white
  studio background is dropped automatically so the head "floats" on the card.

## Rebuild

```bash
node generate.mjs
```

Requirements: **Node 18+** and **ImageMagick 7** (`magick` on your PATH —
`brew install imagemagick`). This rewrites `README.md` and `assets/profile.svg`.
Then commit and push:

```bash
git add -A && git commit -m "Update profile" && git push
```

## Common edits

| Want to change… | Do this |
| --- | --- |
| Any text (role, focus, contacts, repos) | edit `data.json`, rerun |
| The photo | replace `photo.jpg`, rerun |
| GitHub stat numbers | run the `gh api` snippet in the header of `generate.mjs`, paste into `data.json → stats` |
| Portrait look | `data.json → portrait`: `cols` = detail, `contrast`, `densityFloor` = how much the dark shirt shows, `bgLumaCut` = background cutoff |
| Colors | `data.json → theme` |

## Preview locally

`file://` is blocked in most browsers for SVG `<img>`, so serve over HTTP:

```bash
cd assets && python3 -m http.server 8731
# then open http://localhost:8731/profile.svg
```
