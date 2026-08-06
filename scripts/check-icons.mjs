#!/usr/bin/env node
// Fails if the Linux icon set cannot do its job.
//
// Part of `bun run check`, unlike check-release-version.mjs, because every one
// of its assertions is true on an ordinary branch and the failure it guards
// against is invisible in every other way: a deb that installs cleanly, puts a
// valid PNG on disk, and shows a generic placeholder in the menu because the
// path it landed at is one no icon theme reads. See scripts/icon-sizes.mjs.
//
// Pure Node, no image library — a PNG's IHDR is the first chunk and carries the
// dimensions in eight bytes, which is all this needs.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HICOLOR_SIZES, MANIFEST_NAME, SOURCE_NAME } from './icon-sizes.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(repoRoot, 'resources');
const iconsDir = join(resources, 'icons');
const source = join(resources, SOURCE_NAME);

const problems = [];
const fail = (message) => problems.push(message);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width, height and colour type from a PNG's IHDR, or a reason it is not one.
 *
 * The colour type matters as much as the size: type 6 is RGBA, and an icon that
 * lost its alpha channel to an over-eager optimiser renders as a solid block
 * against a panel instead of a masked shape.
 */
function readPngHeader(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { error: 'not a PNG' };
  }
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return { error: 'first chunk is not IHDR' };
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

if (!existsSync(source)) {
  fail(`resources/${SOURCE_NAME} is missing — it is the source every size is derived from`);
} else {
  const header = readPngHeader(source);
  if (header.error !== undefined) {
    fail(`resources/${SOURCE_NAME}: ${header.error}`);
  } else if (header.width !== header.height) {
    fail(`resources/${SOURCE_NAME} is ${header.width}x${header.height}, and must be square`);
  } else if (header.width < Math.max(...HICOLOR_SIZES)) {
    fail(
      `resources/${SOURCE_NAME} is ${header.width}px, below the largest size shipped ` +
        `(${Math.max(...HICOLOR_SIZES)}px) — upscaling is how a blurry icon ships`,
    );
  }
}

for (const size of HICOLOR_SIZES) {
  const name = `${size}x${size}.png`;
  const file = join(iconsDir, name);
  if (!existsSync(file)) {
    fail(`resources/icons/${name} is missing — run \`bun run icons:generate\``);
    continue;
  }
  const header = readPngHeader(file);
  if (header.error !== undefined) {
    fail(`resources/icons/${name}: ${header.error}`);
    continue;
  }
  // The name is what electron-builder installs the file as, so a file whose
  // pixels disagree with its name is an icon filed under the wrong size — the
  // desktop scales it and it looks soft at exactly one size, which is the kind
  // of thing nobody tracks down.
  if (header.width !== size || header.height !== size) {
    fail(`resources/icons/${name} is ${header.width}x${header.height}, not ${size}x${size}`);
  }
  if (header.colorType !== 6) {
    fail(`resources/icons/${name} is not RGBA (PNG colour type ${header.colorType}) — alpha lost`);
  }
}

// A stray size is a real problem rather than clutter: electron-builder installs
// every PNG it finds in this directory, so one at a size hicolor does not
// declare is dead weight in the package and a misleading thing to find here.
if (existsSync(iconsDir)) {
  const expected = new Set(HICOLOR_SIZES.map((size) => `${size}x${size}.png`));
  for (const name of readdirSync(iconsDir)) {
    if (name.endsWith('.png') && !expected.has(name)) {
      fail(`resources/icons/${name} is not a size hicolor declares — see scripts/icon-sizes.mjs`);
    }
  }
}

// The staleness check. Everything above still passes when the artwork has been
// replaced and the sizes have not, because the stale PNGs are perfectly valid
// files showing the previous icon.
const manifestPath = join(iconsDir, MANIFEST_NAME);
if (!existsSync(manifestPath)) {
  fail(`resources/icons/${MANIFEST_NAME} is missing — run \`bun run icons:generate\``);
} else if (existsSync(source)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (manifest.sha256 !== actual) {
    fail(
      `resources/${SOURCE_NAME} has changed since resources/icons/ was generated — ` +
        'run `bun run icons:generate` and commit the result',
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Linux icon set is not shippable:\n${problems.map((p) => `  - ${p}\n`).join('')}`,
  );
  process.exit(1);
}

process.stdout.write(`icons: ${HICOLOR_SIZES.length} hicolor sizes present and current\n`);
