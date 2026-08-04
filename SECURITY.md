# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Report it privately through
[GitHub Security Advisories](https://github.com/sethcarney/boxwarden/security/advisories/new),
which reaches the maintainers without creating a public record.

Include what you can: a description, the steps to reproduce, the platform and
container engine involved, and the boxwarden version. You should get a response
within 72 hours. If the issue is confirmed, a fix is prioritised and a patched
release cut as soon as it is ready.

## Supported Versions

boxwarden is an early MVP. Only the latest release receives fixes; there are no
maintenance branches.

## What this app can do, and what that means

boxwarden is a desktop application that talks to your **container engine's
socket** and **launches programs on your machine**. That is its function, not a
side effect, and it is worth being explicit about the consequences:

- **Access to a Docker socket is root-equivalent on the host.** Any process
  that can reach `/var/run/docker.sock` can start a privileged container that
  mounts `/`. boxwarden does not do this, but a bug in boxwarden is worth more
  to an attacker than a bug in most desktop apps for exactly that reason.
- **Container metadata is attacker-influenced data.** The
  `devcontainer.local_folder` label, the image name, the health string and the
  process table all come from the daemon, which means from anyone who can
  create a container on it. They are treated as untrusted throughout.
- **Startup commands are shell code by design.** A per-container startup
  command is user-authored and is meant to run inside that container. The
  security boundary is that it must never become shell code on the _host_.

Three structural rules keep those from turning into vulnerabilities, and they
are load-bearing rather than stylistic:

1. **Nothing is launched through a shell.** `src/main/editor/launch.ts` and
   `src/main/terminal/launch.ts` use `spawn` with an argv array and never
   `shell: true`. The two macOS emulators that have no CLI at all are handled
   by the pure quoting functions in `src/main/terminal/command.ts`, which are
   property-tested against adversarial input.
2. **The renderer names things by id, never by path.** Every IPC verb that acts
   on a container or project takes an **ID** which the main process resolves
   against its own last scan. A compromised renderer cannot ask the main
   process to open an arbitrary host path or run an arbitrary command.
3. **The renderer is sandboxed and context-isolated**, with a CSP, a deny-all
   permission handler, blocked navigation and new windows, and
   `shell.openExternal` restricted to a closed allow-list of origins.

The full checklist is in [docs/electron-security.md](docs/electron-security.md);
the supply-chain half is in [docs/supply-chain.md](docs/supply-chain.md).

### Out of scope

- The container engine's own configuration. If your Docker socket is
  world-writable, boxwarden showing you the containers on it is not the
  vulnerability.
- `BOXWARDEN_FAKE_DOCKER=1`, a development mode that serves fixtures. It logs a
  loud warning and is not present in a packaged build's normal use.
- Anything requiring an attacker who can already create containers on your
  daemon _and_ execute code as you. That attacker has already won.

## Release Verification

Every release artefact is signed with [cosign](https://docs.sigstore.dev)
keyless signing via Sigstore, and the whole set carries
[SLSA](https://slsa.dev) Build Level 3 provenance. Neither requires you to
trust a key we hold — there is no key. The signature is bound to the GitHub
Actions identity that produced it, and the transparency log makes a signature
that was never published detectable.

Each release carries, for every installer:

| File                    | What it is                                             |
| ----------------------- | ------------------------------------------------------ |
| `<name>`                | the installer itself                                   |
| `<name>.sigstore.json`  | the Sigstore bundle: signature, certificate, log entry |
| `sha256sums.txt`        | checksums for every artefact (itself signed)           |
| `multiple.intoto.jsonl` | SLSA provenance for the whole set                      |

### Verify with cosign

Install [cosign](https://docs.sigstore.dev/cosign/system_config/installation/),
then, replacing `<name>` with the file you downloaded:

```bash
cosign verify-blob <name> \
  --bundle <name>.sigstore.json \
  --certificate-identity-regexp='^https://github\.com/sethcarney/boxwarden/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"
```

The `--certificate-identity-regexp` is the part that matters. Without it,
cosign will happily confirm that _somebody_ signed the file. Pinning the
identity to this repository's release workflow, running on a `v*` tag, is what
makes the answer mean "this came from boxwarden's release pipeline".

### Verify SLSA provenance

Install [slsa-verifier](https://github.com/slsa-framework/slsa-verifier#installation):

```bash
slsa-verifier verify-artifact <name> \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/sethcarney/boxwarden \
  --source-tag <tag>
```

This is the stronger of the two. The provenance is generated in an isolated
workflow the build cannot reach, so it attests the source commit and build
environment rather than only the identity of the signer.

### Verify with SHA-256

The cheap path, if all you want is to know the download was not corrupted or
swapped in transit:

```bash
sha256sum -c sha256sums.txt --ignore-missing
```

Verify `sha256sums.txt` itself with cosign first if you want this to mean
anything against an attacker rather than against a bad network.

## What signing does not do

The macOS and Windows builds are **not code-signed or notarised**. That is a
different mechanism with a different purpose: cosign proves to someone who runs
a command that these bytes came from this pipeline; code signing is what stops
Gatekeeper and SmartScreen from warning everyone who does not. Until there is a
certificate, expect the OS to warn on first launch — see
[docs/releasing.md](docs/releasing.md) for the unsigned-install instructions
that ship with every release.
