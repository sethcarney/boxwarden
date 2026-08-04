# Supply chain

boxwarden asks for a lot of trust. It is a desktop app that talks to your
container engine's socket — which is root-equivalent on the host — and launches
programs on your machine. "Read the source" is a fair answer to that for the
code in this repo; it is not an answer for the installer someone downloads, the
dependencies that go into it, or the CI that turns one into the other.

This file is the other half. It records what is checked, what it costs, and —
the part that cannot live in a file — what has to be switched on in GitHub's
settings for any of it to bind.

[docs/electron-security.md](electron-security.md) is the runtime half:
`webPreferences`, CSP, IPC. [SECURITY.md](../SECURITY.md) is the reporting
policy and the verification instructions for a downloaded release.

## The score

[OpenSSF Scorecard](https://scorecard.dev) grades a repository against
eighteen checks and publishes the result. It runs here weekly and on every push
to `main` (`.github/workflows/scorecard.yml`), and the result is public:

- **Badge / viewer**: <https://scorecard.dev/viewer/?uri=github.com/sethcarney/boxwarden>
- **API**: <https://api.scorecard.dev/projects/github.com/sethcarney/boxwarden>

The score is a report, not a gate. It is deliberately **not** a required status
check: a CVE disclosed in a transitive dependency on a Tuesday would otherwise
block every unrelated pull request until it was patched, which trains people to
merge around it.

Run it locally against the checked-out tree:

```bash
docker run -e GITHUB_AUTH_TOKEN="$(gh auth token)" \
  gcr.io/openssf/scorecard:stable \
  --repo=github.com/sethcarney/boxwarden --show-details
```

## What is in the repo

Every check that a file can answer, and the file that answers it.

| Check                      | Answered by                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| **Dangerous-Workflow**     | No `pull_request_target` anywhere; no `${{ github.event.* }}` interpolated into a `run:` block      |
| **Token-Permissions**      | Top-level `permissions:` on all four workflows; `contents: write` only in the one job that releases |
| **Pinned-Dependencies**    | Every action pinned to a full commit SHA with a `# vX.Y.Z` comment; `bun install --frozen-lockfile` |
| **Dependency-Update-Tool** | `.github/dependabot.yml` — bun, github-actions, devcontainers                                       |
| **SAST**                   | `.github/workflows/codeql.yml`, `security-extended`, plus the type-aware ESLint in `bun run check`  |
| **Fuzzing**                | fast-check property tests: `*.property.test.ts` beside the functions they cover                     |
| **Security-Policy**        | [`SECURITY.md`](../SECURITY.md)                                                                     |
| **License**                | `LICENSE` (MIT)                                                                                     |
| **Binary-Artifacts**       | Nothing executable is committed; `resources/icon.png` is an image                                   |
| **Signed-Releases**        | cosign bundles + SLSA provenance in `.github/workflows/release.yml`                                 |
| **CI-Tests**               | `.github/workflows/check.yml` on every pull request                                                 |
| **Vulnerabilities**        | Nothing to configure — Dependabot keeps the tree current, and this is what proves it                |
| **Maintained**             | Nothing to configure — commit and issue activity over the last 90 days                              |

Three of the eighteen cannot be answered from inside the repository at all:
**Branch-Protection**, **Code-Review** and **CII-Best-Practices**. They are the
next two sections.

### Two decisions worth knowing about

**Actions are pinned by SHA, and that is not paranoia about GitHub.** A tag is
a pointer the action's author can move. `actions/checkout@v5` is therefore a
standing grant of arbitrary code execution on a runner that holds this repo's
token — and the `tj-actions/changed-files` compromise in March 2025 was exactly
that, a retagged release that dumped runner memory into build logs across
tens of thousands of repositories. SHA-pinning turns "whatever they publish
next" into "this commit, which I can read". Dependabot rewrites the SHA and the
version comment together, so the pin does not become a fossil.

**The SLSA generator is the one action that must NOT be SHA-pinned.** It reads
`github.action_ref` at runtime to decide which of its own binary releases to
download, and a SHA there resolves to nothing. That is documented upstream and
the comment in `release.yml` says so, because it looks exactly like the mistake
the rest of this file is about.

## GitHub-side setup

None of this is in the repository, and most of it cannot be. Work through it
once; it is what turns the files above into rules.

### 1. Branch protection on `main`

**Settings → Branches → Add branch ruleset** (or the classic protection rule),
targeting `main`. Scorecard scores this in five tiers, and each tier only
counts once the one below it is complete — so the order matters more than the
list:

| Tier | Score | Settings                                                                                                                                                              |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 3     | Block force pushes; restrict deletions                                                                                                                                |
| 2    | 6     | Require a pull request before merging; require **≥1** approval; require branches to be up to date before merging; require approval of the most recent reviewable push |
| 3    | 8     | Require status checks to pass — add `check` and `Analyze (JavaScript/TypeScript)`                                                                                     |
| 4    | 9     | Require **≥2** approvals **and** require review from Code Owners                                                                                                      |
| 5    | 10    | Dismiss stale approvals when new commits are pushed **and** do not allow bypassing the above settings                                                                 |

**Tiers 1–3 are free.** Turn them all on.

**Tier 4 costs something real on a solo repo**: two required approvals means
you cannot merge your own work without two other people. The way to have the
score and still be able to work — this is what
[`sethcarney/mdm`](https://github.com/sethcarney/mdm) does for its 9 — is to
set the two approvals and the Code Owners requirement, and leave **admin bypass
on**. Scorecard reads the configured rule, so tier 4 counts; you keep the
ability to merge, and tier 5 (which is precisely "admins cannot bypass") does
not. That is an honest 9: the rule is real for everyone who is not you.

Ticking "Require review from Code Owners" is also what makes
[`.github/CODEOWNERS`](../.github/CODEOWNERS) binding rather than advisory.

### 2. Code review

**This one cannot be bought with a setting.** Scorecard looks at the last
thirty changesets on `main` and counts unique reviewers **excluding the
author**. A self-approved pull request scores zero, and so does a direct push.
A single-maintainer repository scores zero on Code-Review, and `mdm` does.

What does move it: a second human, or a review bot with its own identity. Until
then, treat the zero as accurate rather than as something to work around — it
is describing a fact about the project, and the fact is true.

### 3. Repository settings

**Settings → Code security**:

- **Private vulnerability reporting** — on. This is the intake path
  `SECURITY.md` sends people to; without it the link 404s.
- **Dependabot alerts** and **Dependabot security updates** — on. The config
  file schedules routine bumps; these two are what makes a disclosure open a PR
  the same day. Scorecard's Vulnerabilities check reads the same OSV data.
- **CodeQL** — leave _default setup_ **off**. This repo uses advanced setup via
  `.github/workflows/codeql.yml`; enabling both runs the analysis twice and
  produces duplicate alerts.

**Settings → Actions → General**:

- **Workflow permissions** → _Read repository contents and packages
  permissions_. Every workflow here declares what it needs, so the default only
  matters for what someone forgets to declare — and a permissive default is how
  they get forgotten.
- **Allow GitHub Actions to create and approve pull requests** → off. An action
  that can approve a pull request is an action that can satisfy the review
  requirement from section 1.

### 4. The OpenSSF Best Practices badge

CII-Best-Practices is zero until the project is registered — there is nothing
in the repository that can change it. Register at
<https://www.bestpractices.dev/>, work through the questionnaire (most of it is
already true of this repo), and add the badge id to the README.

Worth doing after the first release rather than before: several of its
questions are about release process and vulnerability response, and answering
them honestly needs a release to have happened.

### 5. The badge

Once the first `scorecard.yml` run has published, add to the README:

```markdown
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sethcarney/boxwarden/badge)](https://scorecard.dev/viewer/?uri=github.com/sethcarney/boxwarden)
```

The publish takes one successful run on `main` — the badge 404s until then,
which is expected rather than broken.

## Releases

`release.yml` produces, for every installer:

| File                    | What it is                                         |
| ----------------------- | -------------------------------------------------- |
| `<name>`                | the installer                                      |
| `<name>.sigstore.json`  | Sigstore bundle: signature, certificate, log entry |
| `sha256sums.txt`        | checksums for the whole set, itself signed         |
| `multiple.intoto.jsonl` | SLSA Build L3 provenance for the whole set         |

The verification commands are in
[SECURITY.md](../SECURITY.md#release-verification), where someone who has just
downloaded an installer will look for them.

Three things about the pipeline that are easy to undo by accident:

- **The signing happens before `gh release create`, in the same job.** Signing
  afterwards leaves a window where a draft exists with unsigned assets, and a
  signature uploaded by a separate step is one a failure can silently omit.
- **Provenance is generated by a reusable workflow, not a step.** The whole
  guarantee is that the attestation is produced somewhere the build cannot
  reach. A step in the build job could write its own provenance.
- **Scorecard cannot see a draft release.** `Signed-Releases` reads the public
  releases API, which excludes drafts, so the check reports _inconclusive_
  until a release is actually published — not zero, and not a sign the signing
  failed.

### What signing does and does not buy

Cosign proves that these exact bytes came out of this exact workflow, to
someone who runs a verify command. That is a strong claim and it is worth
having.

**The app is deliberately NOT that someone.** For one release it was: it ran
the same two checks a careful person would — `sha256sum -c`, then
`cosign verify-blob --bundle` with `--certificate-identity` and
`--certificate-oidc-issuer` — over every update it downloaded. That was removed
along with the in-app download itself
(`docs/development.md#why-there-is-no-in-app-download`), because the download
ended at the same installer a browser download does while making
`tuf-repo-cdn.sigstore.dev` a hard runtime dependency: on a network that blocked
it, boxwarden refused to install and said so in words a user reads as an
accusation of tampering.

So the signatures are back to being for the person who verifies by hand — which
is what makes the release notes carrying the verify commands part of the
release procedure rather than decoration. Three consequences:

- **The signing identity is documented, not enforced by a client.** Renaming
  `.github/workflows/release.yml`, or moving the `cosign sign-blob` step into a
  reusable workflow, changes the certificate's SAN — which now breaks the
  `--certificate-identity` string in the release notes rather than every
  installed copy of the app. Cheaper to get wrong, and correspondingly easier to
  leave wrong: check it when the workflow moves.
- **`sha256sums.txt` and one `.sigstore.json` per installer are still required
  assets**, and `releasing.md` says to confirm they are attached before
  publishing. Nothing in the app will notice their absence any more, so this is
  the only check there is.
- **A verifier fetches the trust root over TUF**, which is why the commands in
  the release notes work through a Sigstore key rotation without being reissued.

It is still **not** code signing. The macOS and Windows builds carry no
Developer ID and no Authenticode certificate and are not notarised, so
Gatekeeper and SmartScreen warn on first launch. The two mechanisms answer
different questions and neither substitutes
for the other. `CSC_IDENTITY_AUTO_DISCOVERY: false` in `release.yml` is set
precisely so that the unsigned state is stated rather than buried in a green
log; closing it needs a certificate, and
[docs/roadmap.md](roadmap.md#6-packaging--signing-notarisation-updates) tracks
that.

## What this repo cannot score, and why that is fine

| Check                  | Expected | Why                                                                                                                                                                                                                         |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code-Review**        | 0        | One maintainer. Scorecard excludes the author from the reviewer count, correctly.                                                                                                                                           |
| **Contributors**       | 0        | Needs contributors from ≥2 organisations over the last 30 commits. It measures project size, not security.                                                                                                                  |
| **CII-Best-Practices** | 0        | Until the project is registered — see section 4.                                                                                                                                                                            |
| **Packaging**          | `?`      | Scorecard recognises npm/maven/docker/goreleaser publishing workflows. An Electron installer attached to a GitHub release matches none of them. Inconclusive checks are excluded from the aggregate, so this costs nothing. |
| **Signed-Releases**    | `?`      | Until the first non-draft release exists.                                                                                                                                                                                   |

An aggregate score is a weighted mean over the checks that returned a verdict.
Three structural zeros on a young single-maintainer project is not a finding
about the code — and pretending otherwise, by opening pull requests to review
your own work, would make the number less true rather than more.
