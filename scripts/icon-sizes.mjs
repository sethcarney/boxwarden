// The sizes resources/icons/ ships, shared by the generator and the check.
//
// Every one of these appears in the freedesktop hicolor theme's own
// index.theme, and that is the whole point of the list. A Linux desktop finds
// an application's icon by NAME (`Icon=boxwarden` in the .desktop entry) and
// resolves it by walking the size subdirectories the theme declares — so a PNG
// installed under a size hicolor does not list is simply never looked at.
//
// That is not hypothetical: this app shipped for three releases with one
// 1024x1024 icon and nothing else, which is a size hicolor omits, and Linux
// Mint drew a generic gear in the menu while macOS and Windows were fine. Do
// not add 1024 back here.
//
// https://specifications.freedesktop.org/icon-theme-spec/latest/
export const HICOLOR_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** The artwork every size is derived from, in resources/. */
export const SOURCE_NAME = 'icon.png';

/** Written into resources/icons/ by the generator, read back by the check. */
export const MANIFEST_NAME = 'manifest.json';
