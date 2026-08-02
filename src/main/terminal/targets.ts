import type { HostPlatform, KnownTerminalId, TerminalTarget } from '../../models/index.js';

/**
 * Terminal emulators as DATA, the same way editors are: adding kitty should be
 * a row here, not a branch in the launcher.
 *
 * Order is preference order, and it is the whole UX of the feature — the first
 * one found is the default, so a GNOME user should not get xterm. The rule
 * used: full desktop-environment terminals first (they are what the user
 * already has open), then the standalone terminals people install on purpose,
 * then the portable fallbacks that are always present and nobody chooses.
 *
 * Every entry resolves a real executable rather than an `.app` directory or a
 * shell alias — see the note on Windows spawnability in
 * `src/main/discovery/resolve.ts`.
 */

const DARWIN: readonly HostPlatform[] = ['darwin'];
const LINUX: readonly HostPlatform[] = ['linux'];
const WINDOWS: readonly HostPlatform[] = ['win32'];

/** `terminal-name -e <argv>`: the single most common Linux convention. */
function dashE(command: string): TerminalTarget['discovery'] {
  return [
    { kind: 'path-lookup', command },
    { kind: 'well-known-dir', paths: [`/usr/bin/${command}`, `/usr/local/bin/${command}`] },
  ];
}

const TARGETS: Record<KnownTerminalId, TerminalTarget> = {
  'macos-terminal': {
    id: 'macos-terminal',
    displayName: 'Terminal',
    platforms: DARWIN,
    discovery: [
      {
        kind: 'macos-bundle',
        bundleId: 'com.apple.Terminal',
        cliRelativePath: 'Contents/MacOS/Terminal',
      },
      {
        kind: 'well-known-dir',
        paths: [
          // Ventura and later moved the stock utilities out of /Applications.
          '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
          '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
        ],
      },
    ],
    invocation: { kind: 'applescript', application: 'Terminal', dialect: 'terminal-app' },
  },

  iterm2: {
    id: 'iterm2',
    displayName: 'iTerm2',
    platforms: DARWIN,
    discovery: [
      {
        kind: 'macos-bundle',
        bundleId: 'com.googlecode.iterm2',
        cliRelativePath: 'Contents/MacOS/iTerm2',
      },
      { kind: 'well-known-dir', paths: ['/Applications/iTerm.app/Contents/MacOS/iTerm2'] },
    ],
    // "iTerm", not "iTerm2": the application's AppleScript name never followed
    // the bundle rename.
    invocation: { kind: 'applescript', application: 'iTerm', dialect: 'iterm2' },
  },

  'gnome-terminal': {
    id: 'gnome-terminal',
    displayName: 'GNOME Terminal',
    platforms: LINUX,
    discovery: dashE('gnome-terminal'),
    // `--` and not `-e`: gnome-terminal deprecated `-e` and its replacement
    // takes the command as a plain argv tail, which is the shape we want anyway.
    invocation: { kind: 'argv', flags: ['--'] },
  },

  konsole: {
    id: 'konsole',
    displayName: 'Konsole',
    platforms: LINUX,
    discovery: dashE('konsole'),
    invocation: { kind: 'argv', flags: ['-e'] },
  },

  'xfce4-terminal': {
    id: 'xfce4-terminal',
    displayName: 'Xfce Terminal',
    platforms: LINUX,
    discovery: dashE('xfce4-terminal'),
    // `-x` rather than `--command`: it takes the rest of the line as argv,
    // where `--command` takes one string it then splits on whitespace itself.
    invocation: { kind: 'argv', flags: ['-x'] },
  },

  kitty: {
    id: 'kitty',
    displayName: 'kitty',
    platforms: LINUX,
    discovery: dashE('kitty'),
    invocation: { kind: 'argv', flags: [] },
  },

  wezterm: {
    id: 'wezterm',
    displayName: 'WezTerm',
    platforms: LINUX,
    discovery: dashE('wezterm'),
    invocation: { kind: 'argv', flags: ['start', '--'] },
  },

  alacritty: {
    id: 'alacritty',
    displayName: 'Alacritty',
    platforms: LINUX,
    discovery: dashE('alacritty'),
    invocation: { kind: 'argv', flags: ['-e'] },
  },

  'x-terminal-emulator': {
    id: 'x-terminal-emulator',
    displayName: 'Default terminal',
    platforms: LINUX,
    discovery: [
      { kind: 'path-lookup', command: 'x-terminal-emulator' },
      { kind: 'well-known-dir', paths: ['/usr/bin/x-terminal-emulator'] },
    ],
    // The Debian alternatives symlink, so `-e` means whatever the terminal
    // behind it means. `command-string` is the form every implementation of
    // that convention accepts, since the oldest of them split the string
    // themselves.
    invocation: { kind: 'command-string', flags: ['-e'] },
  },

  xterm: {
    id: 'xterm',
    displayName: 'xterm',
    platforms: LINUX,
    discovery: dashE('xterm'),
    invocation: { kind: 'argv', flags: ['-e'] },
  },

  'windows-terminal': {
    id: 'windows-terminal',
    displayName: 'Windows Terminal',
    platforms: WINDOWS,
    discovery: [
      { kind: 'path-lookup', command: 'wt' },
      { kind: 'well-known-dir', paths: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe'] },
    ],
    invocation: { kind: 'argv', flags: ['new-tab'] },
    argumentEscaping: 'windows-terminal',
  },

  'windows-console': {
    id: 'windows-console',
    displayName: 'Console window',
    platforms: WINDOWS,
    discovery: [{ kind: 'well-known-dir', paths: ['%SystemRoot%\\System32\\conhost.exe'] }],
    // The fallback for a machine without Windows Terminal, which is every
    // Windows 10 install that has not opted in. conhost is the console host
    // itself, so handing it a command line opens that command in a new console.
    invocation: { kind: 'argv', flags: [] },
  },
};

/** Probe order, and therefore the default. Platform-filtered before anything is spawned. */
export const TERMINAL_ORDER: readonly KnownTerminalId[] = [
  // iTerm2 ahead of Terminal, and this ordering is load-bearing: Terminal.app
  // ships with macOS, so probing it first would make it the default on every
  // Mac and leave iTerm2 permanently unreachable as one. The same reasoning
  // puts x-terminal-emulator and xterm at the end of the Linux run.
  'iterm2',
  'macos-terminal',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'kitty',
  'wezterm',
  'alacritty',
  'x-terminal-emulator',
  'xterm',
  'windows-terminal',
  'windows-console',
];

export const TERMINAL_TARGETS: readonly TerminalTarget[] = TERMINAL_ORDER.map((id) => TARGETS[id]);

export function terminalsFor(platform: HostPlatform): readonly TerminalTarget[] {
  return TERMINAL_TARGETS.filter((target) => target.platforms.includes(platform));
}

export function terminalTarget(id: string): TerminalTarget | undefined {
  return TERMINAL_TARGETS.find((target) => target.id === id);
}
