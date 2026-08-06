#!/usr/bin/env node
// Regenerates resources/icons/ from resources/icon.png.
//
// Run this after changing the artwork, then commit what it writes — the sizes
// are committed rather than produced at build time, because the build machine
// is a CI runner with no image tooling on it and a missing icon is a failure
// that ships silently. `bun run check:icons` is the half that runs everywhere.
//
// ImageMagick is the only dependency, and it is required only here.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HICOLOR_SIZES, MANIFEST_NAME, SOURCE_NAME } from './icon-sizes.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(repoRoot, 'resources');
const iconsDir = join(resources, 'icons');
const source = join(resources, SOURCE_NAME);

/** ImageMagick 7 is `magick`; 6 is `convert`. Both are still in the wild. */
function findImageMagick() {
  for (const binary of ['magick', 'convert']) {
    try {
      execFileSync(binary, ['-version'], { stdio: 'ignore' });
      return binary;
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    'ImageMagick not found. Install it and re-run:\n' +
      '  Debian/Ubuntu/Mint  sudo apt install imagemagick\n' +
      '  macOS               brew install imagemagick\n' +
      '  Fedora              sudo dnf install ImageMagick',
  );
}

const magick = findImageMagick();
mkdirSync(iconsDir, { recursive: true });

for (const size of HICOLOR_SIZES) {
  const out = join(iconsDir, `${size}x${size}.png`);
  execFileSync(magick, [
    source,
    // Lanczos over the default: the artwork is flat geometry with hard edges,
    // and a softer filter turns the cube's silhouette to mush by 16px.
    '-filter',
    'Lanczos',
    '-resize',
    `${size}x${size}`,
    // Reproducible bytes: without this every run rewrites all eight files with
    // a fresh timestamp chunk, so `git status` can never tell a real change
    // from a re-run.
    '-strip',
    // RGBA, kept explicit. ImageMagick will happily drop to palette or
    // greyscale for a small image, and a 16px icon that quietly lost its alpha
    // is a black square on a dark panel.
    '-define',
    'png:color-type=6',
    out,
  ]);
  process.stdout.write(`wrote ${size}x${size}.png\n`);
}

// The staleness guard. Nothing else can notice that the artwork moved on and
// the sizes did not: the old PNGs are still valid, still the right dimensions,
// and still show the previous icon.
const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
writeFileSync(
  join(iconsDir, MANIFEST_NAME),
  `${JSON.stringify({ source: SOURCE_NAME, sha256, sizes: HICOLOR_SIZES }, null, 2)}\n`,
);
process.stdout.write(`wrote ${MANIFEST_NAME}\n`);
