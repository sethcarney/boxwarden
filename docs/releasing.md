# Releasing boxwarden

How a commit becomes something a person can download and install on macOS,
Linux, or Windows.

The short version: **bump the version, push a tag, edit the draft, publish.**
Everything between the tag and the draft is
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

```
  package.json version   ─┐
  git tag v<version>     ─┴─►  verify  ─►  build ×3 (mac/linux/win)  ─►  draft release
                                                                            │
                                                                    you read it and publish
```

---

## Cutting a release

### 1. Decide the version

Semver, and the tag is the version with a `v` in front of it — `0.1.0` →
`v0.1.0`. A prerelease (`1.0.0-rc.1`) is marked as one on GitHub automatically,
so it does not become the "latest release" a download link resolves to. Use one
for anything you want people to try without treating it as the recommendation.

While the app is
[unproven against a real daemon](./roadmap.md#verified-and-unverified), stay in
`0.x`.

### 2. Bump `package.json`

```bash
# edit "version" in package.json, then:
bun run check:release-version     # sanity-check the number before tagging
git commit -am "Release v0.1.0"
```

**`package.json` is the only version there is.** electron-builder reads it and
nothing else; it is what ends up in `boxwarden-0.1.0.dmg`, in the About box,
and in every bug report. The tag is just a name pointing at the commit that
produced it. `bun.lock` does not record the root version, so bumping it does
not touch the lockfile.

### 3. Tag and push

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

Push the commit before the tag. A tag that arrives first builds a commit the
default branch does not have yet, and the release then documents itself with a
diff nobody can see.

### 4. Wait for the workflow

Three jobs, in this order:

| Job       | Runs on              | What it does                                                                                 |
| --------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `verify`  | ubuntu               | `bun run check`, then `check:release-version` — the tag must equal `v<package.json version>` |
| `build`   | macos/ubuntu/windows | `bun run dist:<os> -- --publish never`, then uploads the installers as workflow artefacts    |
| `publish` | ubuntu               | Collects all three platforms' artefacts and creates **one draft release** with them attached |

`verify` exists because a tag can point at any commit, including one that never
went through a pull request — `check.yml` gates `main`, it does not gate this.
`build` does not publish, because three jobs each creating "the" release race
each other and the loser quietly makes a second draft.

`fail-fast` is off: if Windows breaks, macOS and Linux still finish, so you
learn "only Windows is broken" instead of "something is broken".

### 5. Edit the draft, then publish it

The draft has generated notes (the merged PRs since the last tag) and every
artefact attached. Two things to add before pressing **Publish release**:

- **A sentence about what actually changed**, above the generated list. The
  generated list is a changelog, not a summary.
- **The install preamble below**, because the builds are unsigned and every
  platform will interpose on first launch. Somebody who is not expecting that
  reads it as "this app is malware".

```markdown
### Install

- **macOS** — open the `.dmg`, drag boxwarden to Applications. The build is
  unsigned and un-notarised, so Gatekeeper refuses it on first launch:
  right-click the app and choose _Open_.
- **Linux** — prefer the `.deb` (`sudo apt install ./boxwarden_<version>_amd64.deb`).
  It sets up `chrome-sandbox` and installs an AppArmor profile the AppImage
  cannot, which Ubuntu 24.04 needs. The `.AppImage` is for everywhere else:
  `chmod +x` and run it.
- **Windows** — run the `Setup .exe`. Per-user, no admin rights. The build is
  unsigned, so SmartScreen interposes: _More info_ → _Run anyway_.

There is no auto-update. Installing a later release over the top is the update.
```

[running.md](./running.md#3-installing-it-on-your-computer) is the longer
version of that, including uninstalling.

---

## What gets attached

Per platform, from `release/`:

| Platform | Artefacts                                                                              |
| -------- | -------------------------------------------------------------------------------------- |
| macOS    | `boxwarden-<v>.dmg`, `boxwarden-<v>-arm64.dmg`, matching `-mac.zip`s, `latest-mac.yml` |
| Linux    | `boxwarden-<v>.AppImage`, `boxwarden_<v>_amd64.deb` (plus arm64), `latest-linux.yml`   |
| Windows  | `boxwarden Setup <v>.exe`, `latest.yml`                                                |

Plus a `.blockmap` beside each installer that has one.

The unpacked application directories electron-builder also leaves in `release/`
(`mac/`, `linux-unpacked/`, `win-unpacked/`) are deliberately **not** uploaded —
they are the same bytes as the installers, unzipped, and nobody installs from
them.

The `latest*.yml` manifests are attached even though nothing reads them yet.
They are what `electron-updater` would consume, they cost a kilobyte, and a
release published without them cannot be turned into an update source
afterwards — the build that would need to find them is the one already
installed.

### Which architectures

macOS x64 and arm64 both come off the arm64 runner: electron-builder downloads
the other architecture's Electron distribution and packages it, which is the
one cross-build in this matrix that is genuinely reliable. Linux and Windows
build both arches on their own x64 runner the same way.

Only the x64 Linux build has ever been launched (headlessly, against
fixtures). **arm64 on any platform is untested** — see
[roadmap.md](./roadmap.md#verified-and-unverified).

---

## Dry-running the pipeline

Run the workflow by hand from the Actions tab (**release** → _Run workflow_).
It builds all three platforms and uploads the artefacts, and creates **no**
release — the `publish` job is gated on the ref being a tag.

Use it for two things:

- Proving a change to the workflow or to `electron-builder.yml` before a tag
  exists to live with.
- Getting installers to try on a real machine. The artefacts are on the run's
  summary page for 7 days.

The version check still runs on a dry run, minus the tag comparison: it cannot
compare against a tag that does not exist, but it still refuses `0.0.0`.

Locally, the same builds are `bun run dist:mac` / `:linux` / `:win` — but
[cross-building mostly does not work](./running.md#3-installing-it-on-your-computer),
which is the reason this workflow exists.

---

## Why `check:release-version` is not part of `bun run check`

`bun run check` runs on every pull request. The version check's whole job is to
reject the placeholder `0.0.0` and to demand a tag that matches — neither of
which is true on an ordinary branch, and both of which would then fail every
PR. It runs where it means something: once, in `verify`, on the tag.

It is still worth running by hand at step 2, before you create a tag you cannot
move.

---

## What this process does not do

All three are tracked in
[roadmap.md](./roadmap.md#6-packaging--signing-notarisation-updates).

- **Signing and notarisation.** `CSC_IDENTITY_AUTO_DISCOVERY: false` is set on
  the macOS build deliberately: with it unset, electron-builder searches the
  runner's empty keychain, fails to sign, and reports it as a warning inside an
  otherwise green log — so an unsigned release looks exactly like a signed one
  from the outside. Saying it out loud is the honest version until there is a
  certificate.

  Adding one later means: a Developer ID Application certificate and an
  app-specific password in repository secrets, `CSC_LINK`/`CSC_KEY_PASSWORD`
  and the notarisation credentials in the build job's `env`, and dropping the
  line above. The Windows equivalent is a code-signing certificate through the
  same `CSC_LINK` pair.

- **Auto-update.** The manifests are published; nothing consumes them. Wiring
  up `electron-updater` is a change to the app, not to this workflow.

- **ASAR integrity.** The fuse that would detect a tampered archive is off.

---

## If something goes wrong

| Symptom                                                    | What happened                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify` fails on `tag matches package.json`               | The tag and the version disagree. Delete the tag (`git tag -d`, `git push --delete origin <tag>`), fix `package.json`, commit, re-tag. Nothing was published. |
| `verify` fails on `bun run check`                          | The tagged commit does not pass the ordinary gate. Fix it on `main` first — the tag has to move to the fixed commit.                                          |
| One platform's `build` fails                               | The other two still finished. Fix, then re-run — but delete the draft first, or re-running creates artefacts for a release that already exists.               |
| `publish` fails on `--verify-tag`                          | The tag is not on the remote any more. Nothing partial was created.                                                                                           |
| The draft has only some platforms attached                 | A `build` job failed after `publish` had started, or you re-ran a subset. Delete the draft and re-run the whole workflow rather than patching it up.          |
| A release went out with the wrong version in the filenames | Publish a corrected one. Do not retag: a tag people may already have fetched is not yours to move.                                                            |

Re-running a release is safe up to the point where the draft is published,
because a draft is not visible and its assets are not addressable. After that,
the only correct fix is another version.
