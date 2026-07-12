#!/usr/bin/env node
/**
 * generate.mjs — builds assets/profile.svg and README.md from data.json + photo.jpg
 *
 * Usage:
 *   node generate.mjs
 *
 * How it works:
 *   1. Shells out to ImageMagick (`magick`) to crop the photo to the portrait
 *      aspect and downsample it to a cols×rows RGB grid (PPM P6 on stdout).
 *   2. Maps each grid cell to an ASCII glyph (by brightness) and an SVG fill
 *      (by the cell's real color). Near-white background cells are dropped so
 *      the head/shoulders "float" on the dark terminal card.
 *   3. Lays out a 1200×760 neofetch-style card: ASCII portrait on the left,
 *      key·dots·value system table + stat boxes on the right.
 *   4. Writes assets/profile.svg and a matching README.md.
 *
 * Requirements: Node 18+ and ImageMagick 7 (`magick` on PATH).
 * To refresh the GitHub stat numbers, run:
 *   gh api users/DimaPhil --jq '{public_repos,followers}'
 *   gh api "users/DimaPhil/repos?per_page=100&type=owner" \
 *     --jq '{original:[.[]|select(.fork==false)]|length, stars:([.[]|select(.fork==false)|.stargazers_count]|add)}'
 * ...and paste the numbers into data.json -> stats[].
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(ROOT, 'data.json'), 'utf8'));
const T = data.theme;
const P = data.portrait;

/* ----------------------------------------------------------------------- *
 * Canvas + layout geometry (all coordinates in the 1200×760 viewBox).
 * ----------------------------------------------------------------------- */
const W = 1200, H = 700;
const PORTRAIT = { x: 42, y: 96, w: 364, h: 400 };    // ASCII portrait region (name removed → moved up)
const R = { keyX: 488, dotsX: 700, valueX: 786, right: 1122 };
const STAT = { w: 148, h: 56, gap: 14, xs: [488, 650, 812, 974] };

/* ----------------------------------------------------------------------- *
 * 1. Decode the photo into a cols×rows RGB grid via ImageMagick.
 * ----------------------------------------------------------------------- */
function pixelGrid(photoPath, cols, rows) {
  const args = [
    photoPath,
    '-resize', `${PORTRAIT.w}x${PORTRAIT.h}^`, // fill the region aspect...
    '-gravity', 'center', '-extent', `${PORTRAIT.w}x${PORTRAIT.h}`, // ...then crop to it
    '-resize', `${cols}x${rows}!`,             // force to the sampling grid
    '-colorspace', 'sRGB', '-depth', '8', 'ppm:-',
  ];
  const res = spawnSync('magick', args, { maxBuffer: 1 << 27 });
  if (res.status !== 0) {
    throw new Error('ImageMagick failed: ' + (res.stderr || res.error || 'unknown'));
  }
  return parsePPM(res.stdout);
}

// Minimal binary PPM (P6) reader — no dependencies.
function parsePPM(buf) {
  let pos = 0;
  const token = () => {
    while (pos < buf.length) {
      const c = buf[pos];
      if (c === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; } // '#' comment
      else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;    // whitespace
      else break;
    }
    const start = pos;
    while (pos < buf.length) {
      const c = buf[pos];
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
      pos++;
    }
    return buf.toString('ascii', start, pos);
  };
  const magic = token();
  if (magic !== 'P6') throw new Error('unexpected PPM magic: ' + magic);
  const w = +token(), h = +token(), maxv = +token();
  pos++; // exactly one whitespace byte separates the header from the data
  const data = buf.subarray(pos);
  return { w, h, maxv, data };
}

/* ----------------------------------------------------------------------- *
 * 2. Color / glyph mapping.
 * ----------------------------------------------------------------------- */
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v) => clamp8(v).toString(16).padStart(2, '0');

function portraitCells(grid) {
  const { w: cols, h: rows, data } = grid;
  const cellW = PORTRAIT.w / cols;
  const cellH = PORTRAIT.h / rows;
  const fontSize = +(cellH * 1.02).toFixed(1); // glyph ~= cell height for a dense read
  const ramp = P.ramp;
  const out = [];

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const i = (ry * cols + rx) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = luma(r, g, b);

      // Drop the near-white studio background so the subject floats on the card.
      if (l > P.bgLumaCut && sat(r, g, b) < P.bgSatCut) continue;

      // On a dark card, ink reads as light: BRIGHTER pixels -> denser glyphs.
      // A contrast curve separates mid-tones; a density floor keeps the dark
      // shoulders/shirt visible as a silhouette instead of vanishing.
      let t = l / 255;
      t = Math.max(0, Math.min(1, (t - 0.5) * P.contrast + 0.5));
      const d = P.densityFloor + (1 - P.densityFloor) * t;
      const gi = Math.max(0, Math.min(ramp.length - 1, Math.round(d * (ramp.length - 1))));
      const ch = ramp[gi];

      // Fill = the real pixel color, chroma-boosted (warm skin, not grey) and
      // gently lifted so nothing collapses fully to black on the dark bg.
      const lift = (c) => clamp8(P.shadowLift + (l + (c - l) * P.satBoost) * P.gain);
      const fill = '#' + hex2(lift(r)) + hex2(lift(g)) + hex2(lift(b));

      const x = +(PORTRAIT.x + rx * cellW + cellW / 2).toFixed(1);
      const y = +(PORTRAIT.y + ry * cellH + cellH * 0.82).toFixed(1);
      out.push(`<text x="${x}" y="${y}" fill="${fill}">${ch}</text>`);
    }
  }
  return { cells: out.join(''), fontSize };
}

/* ----------------------------------------------------------------------- *
 * 3. SVG assembly.
 * ----------------------------------------------------------------------- */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildSVG(grid) {
  const { cells, fontSize } = portraitCells(grid);
  const rowH = 40, headerAdvance = 42, sectionGap = 8;

  // Right-hand key·dots·value table (vertical cursor flows top-down).
  const right = [];
  let y = 136;
  for (const sec of data.sections) {
    if (sec.title) {
      right.push(`<text x="${R.keyX}" y="${y}" class="section">${esc(sec.title)}</text>`);
      y += headerAdvance;
    }
    for (const row of sec.rows) {
      const vClass = row.accent ? 'accent' : 'value';
      right.push(
        `<text x="${R.keyX}" y="${y}" class="key">${esc(row.key)}</text>` +
        `<text x="${R.dotsX}" y="${y}" class="dots">········</text>` +
        `<text x="${R.valueX}" y="${y}" class="${vClass}">${esc(row.value)}</text>`
      );
      y += rowH;
    }
    y += sectionGap;
  }

  // Stat boxes.
  right.push(`<text x="${R.keyX}" y="${y}" class="section">${esc(data.statsLabel)}</text>`);
  const boxY = y + 16;
  data.stats.forEach((s, i) => {
    const x = STAT.xs[i];
    right.push(
      `<rect x="${x}" y="${boxY}" width="${STAT.w}" height="${STAT.h}" rx="12" class="statBox"/>` +
      `<text x="${x + 14}" y="${boxY + 20}" class="statLabel">${esc(s.label)}</text>` +
      `<text x="${x + 14}" y="${boxY + 44}" class="statValue">${esc(s.value)}</text>`
    );
  });

  const id = data.identity;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(id.name)} — terminal profile</title>
  <desc id="desc">Terminal-style GitHub profile: ASCII portrait, focus areas, contacts and public GitHub statistics.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${T.bgStops[0]}"/>
      <stop offset="0.52" stop-color="${T.bgStops[1]}"/>
      <stop offset="1" stop-color="${T.bgStops[2]}"/>
    </linearGradient>
    <radialGradient id="cyanGlow" cx="0.16" cy="0.60" r="0.55">
      <stop offset="0" stop-color="${T.cyanGlow}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${T.cyanGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="violetGlow" cx="0.93" cy="0.02" r="0.62">
      <stop offset="0" stop-color="${T.violetGlow}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${T.violetGlow}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="portraitClip">
      <rect x="${PORTRAIT.x}" y="${PORTRAIT.y}" width="${PORTRAIT.w}" height="${PORTRAIT.h}" rx="20"/>
    </clipPath>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
      .eyebrow  { font-size: 12px; fill: ${T.eyebrow}; letter-spacing: 2.0px; font-weight: 700; }
      .hero     { font-size: 24px; fill: ${T.hero}; font-weight: 700; letter-spacing: -0.5px; }
      .tagHero  { font-size: 19px; fill: ${T.accent}; font-weight: 700; letter-spacing: -0.3px; }
      .key      { font-size: 14px; fill: ${T.key}; font-weight: 700; }
      .dots     { font-size: 14px; fill: ${T.dots}; letter-spacing: 1.5px; }
      .value    { font-size: 14px; fill: ${T.value}; }
      .accent   { font-size: 14px; fill: ${T.accent}; }
      .section  { font-size: 12px; fill: ${T.section}; letter-spacing: 1.6px; font-weight: 700; }
      .statBox  { fill: ${T.statBoxFill}; stroke: ${T.statBoxStroke}; stroke-opacity: 0.85; }
      .statLabel{ font-size: 10px; fill: ${T.statLabel}; letter-spacing: 1.2px; font-weight: 700; }
      .statValue{ font-size: 22px; fill: ${T.statValue}; font-weight: 700; }
      .px       { font-size: ${fontSize}px; }
      .oline    { font-size: 13px; fill: ${T.value}; }
    </style>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="24" fill="url(#cyanGlow)"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="24" fill="url(#violetGlow)"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="24" fill="none" stroke="${T.statBoxStroke}" stroke-opacity="0.6"/>
  <line x1="447" y1="48" x2="447" y2="${H - 44}" stroke="${T.divider}" stroke-opacity="0.7"/>

  <!-- LEFT: ASCII portrait + positioning -->
  <text x="54" y="60" class="eyebrow">${esc(id.eyebrowLeft)}</text>
  <rect x="${PORTRAIT.x}" y="${PORTRAIT.y}" width="${PORTRAIT.w}" height="${PORTRAIT.h}" rx="20" fill="${T.portraitPanel}"/>
  <g clip-path="url(#portraitClip)" class="px">${cells}</g>
  <rect x="${PORTRAIT.x}" y="${PORTRAIT.y}" width="${PORTRAIT.w}" height="${PORTRAIT.h}" rx="20" fill="none" stroke="${T.statBoxStroke}" stroke-opacity="0.8"/>
  <text x="54" y="530" class="tagHero">${esc(id.tagline1)}</text>
  <text x="54" y="556" class="tagHero">${esc(id.tagline2)}</text>
  <text x="54" y="600" class="section">${esc(id.credLabel)}</text>
  <text x="54" y="628" class="oline">${esc(id.cred1)}</text>
  <text x="54" y="650" class="oline">${esc(id.cred2)}</text>

  <!-- RIGHT: positioning + signal -->
  <text x="${R.keyX}" y="60" class="eyebrow">${esc(id.eyebrowRight)}</text>
  <text x="${R.keyX}" y="92" class="hero">${esc(id.roleHero)}</text>
  ${right.join('\n  ')}
</svg>
`;
}

/* ----------------------------------------------------------------------- *
 * 4. README.md assembly.
 * ----------------------------------------------------------------------- */
function buildREADME() {
  const links = data.links.map((l) => `  <a href="${l.href}">${l.label}</a>`).join(' ·\n');
  const selected = data.selected
    .map((s) => `- [\`${s.repo}\`](https://github.com/${data.githubUser}/${s.repo}) — ${s.desc}`)
    .join('\n');
  return `<div align="center">
  <img src="./assets/profile.svg" width="100%" alt="${data.identity.name} — terminal profile" />
</div>

<div align="center">
${links}
</div>

<br />

### Selected systems

${selected}

<sub>${data.footerNote}</sub>
`;
}

/* ----------------------------------------------------------------------- *
 * Run.
 * ----------------------------------------------------------------------- */
const cols = P.cols;
const rows = Math.max(1, Math.round(cols * (PORTRAIT.h / PORTRAIT.w) * P.charAspect));
const grid = pixelGrid(join(ROOT, 'photo.jpg'), cols, rows);

mkdirSync(join(ROOT, 'assets'), { recursive: true });
const svg = buildSVG(grid);
writeFileSync(join(ROOT, 'assets', 'profile.svg'), svg, 'utf8');
writeFileSync(join(ROOT, 'README.md'), buildREADME(), 'utf8');

console.log(`✓ portrait grid ${cols}×${rows} (${grid.data.length / 3} px)`);
console.log(`✓ assets/profile.svg  (${(svg.length / 1024).toFixed(0)} KB)`);
console.log('✓ README.md');
