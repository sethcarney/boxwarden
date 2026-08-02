import type { DockerEnvironment, EndpointFailure } from './docker-endpoint.js';
import type { EngineSelection } from './engine.js';
import { enginesFrom, selectionIsReachable } from './engine.js';
import { distrosMissingSocat } from './wsl.js';

/**
 * Turning "boxwarden found nothing" into "here is what to do about it".
 *
 * This is the part of the app that earns its keep on a machine where nothing
 * works. Discovery already knows far more than it used to say: which sockets
 * were absent versus refusing, whether WSL is installed, whether a distro is
 * running, whether the relay binary is there. Reporting "no container engine"
 * on top of all that is throwing away the diagnosis.
 *
 * Kept pure and separate from probing so every branch below is a unit test
 * rather than a Windows machine in a particular state of disrepair — which is
 * the only other way to see most of them.
 *
 * WRITING RULE FOR THE TEXT IN THIS FILE: every advisory names what is wrong
 * AND what to type. An advisory that only describes the problem belongs in the
 * diagnostics list, not here.
 */

/** Platform, without depending on Node's types — the renderer's tsconfig has none. */
export type HostPlatform = 'win32' | 'darwin' | 'linux' | 'other';

export function hostPlatform(platform: string): HostPlatform {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other';
}

export type AdviceSeverity = 'error' | 'warning' | 'info';

export interface AdviceLink {
  readonly label: string;
  /**
   * MUST be an https URL whose origin is in ALLOWED_EXTERNAL_ORIGINS in
   * src/main/index.ts. Anything else is silently refused by the window-open
   * handler, so a link added here without the origin added there renders as a
   * dead link — check both.
   */
  readonly url: string;
}

export interface Advice {
  /** Stable across runs, so React can key on it and a dismissal could persist. */
  readonly id: string;
  readonly severity: AdviceSeverity;
  readonly title: string;
  readonly body: string;
  /** Shell one-liners, offered with a copy button. Empty when there is nothing to type. */
  readonly commands: readonly string[];
  readonly links: readonly AdviceLink[];
}

/**
 * The OpenSSH `ssh-agent` service on Windows, which ships DISABLED.
 *
 * Three states because they are three different problems with three different
 * fixes: a stopped service needs starting, a disabled one needs its start type
 * changed first or it will not survive a reboot, and `unknown` means the probe
 * could not tell — which must produce no advisory at all rather than a guess.
 */
export type WindowsAgentService = 'running' | 'stopped' | 'disabled' | 'unknown';

/** What the main process saw when it looked for an agent on THIS machine. */
export interface SshAgentHostProbe {
  /** SSH_AUTH_SOCK in boxwarden's own environment. Absent means unset. macOS and Linux. */
  readonly authSock?: string;
  /** Whether that path exists. Absent when there was no path to check. */
  readonly authSockExists?: boolean;
  /** Windows only. */
  readonly service?: WindowsAgentService;
  /**
   * boxwarden is itself running inside a container.
   *
   * Everything above then describes the CONTAINER's environment, not the
   * developer's machine — `bun run devcontainer:open` uses
   * docker-outside-of-docker, so boxwarden sees the host's containers while
   * `process.env` and the filesystem it can stat belong to the container it is
   * in. Advice derived from those fields would be reporting on the wrong
   * machine, so it is suppressed.
   */
  readonly inContainer: boolean;
}

export interface SshAgentAdviceInput {
  readonly host: SshAgentHostProbe;
  /**
   * Names of containers in this scan whose SSH_AUTH_SOCK points at nothing —
   * `containersMissingAgentSocket` over the container list.
   */
  readonly unmountedIn: readonly string[];
}

export interface AdviceInput {
  readonly platform: HostPlatform;
  readonly environment: DockerEnvironment;
  readonly selection: EngineSelection;
  /**
   * Absent means the host was not probed, and the SSH advisory is then
   * suppressed entirely. That is the honest reading — there is no evidence to
   * advise from — and it keeps callers that do not probe (tests, and anything
   * reasoning about an environment alone) from emitting advice about a machine
   * nobody looked at.
   */
  readonly sshAgent?: SshAgentAdviceInput;
}

const DOCS = {
  wslInstall: {
    label: 'Install WSL (Microsoft)',
    url: 'https://learn.microsoft.com/windows/wsl/install',
  },
  dockerDesktop: { label: 'Docker Desktop', url: 'https://docs.docker.com/desktop/' },
  dockerEngine: {
    label: 'Docker Engine for Linux',
    url: 'https://docs.docker.com/engine/install/',
  },
  dockerPostInstall: {
    label: 'Docker post-install (the docker group)',
    url: 'https://docs.docker.com/engine/install/linux-postinstall/',
  },
  podman: { label: 'Podman', url: 'https://podman.io/docs/installation' },
  podmanDesktop: { label: 'Podman Desktop', url: 'https://podman-desktop.io/downloads' },
  orbstack: { label: 'OrbStack', url: 'https://orbstack.dev' },
  rancher: { label: 'Rancher Desktop', url: 'https://rancherdesktop.io' },
  colima: { label: 'Colima', url: 'https://github.com/abiosoft/colima' },
  devcontainers: { label: 'What a dev container is', url: 'https://containers.dev' },
  sshInContainers: {
    label: 'Sharing git credentials with your container',
    url: 'https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials',
  },
  windowsSshKeys: {
    label: 'OpenSSH key management (Microsoft)',
    url: 'https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement',
  },
} as const satisfies Record<string, AdviceLink>;

/** Every failure code seen across the attempts, for the "why did nothing work" branches. */
function failureCodes(environment: DockerEnvironment): ReadonlySet<EndpointFailure['code']> {
  return new Set(
    environment.attempts.flatMap((attempt) => (attempt.ok ? [] : [attempt.failure.code])),
  );
}

/**
 * The install menu, per platform.
 *
 * Deliberately a menu and not a recommendation. boxwarden works with all of
 * these and has no business steering a developer towards one vendor; the
 * ordering is by how common they are on that platform, nothing more.
 */
function installOptions(platform: HostPlatform): Advice {
  switch (platform) {
    case 'win32':
      return {
        id: 'install-engine-win32',
        severity: 'error',
        title: 'No container engine is installed',
        body: 'boxwarden found no container engine on this machine. On Windows every one of these runs its engine inside WSL2, so install WSL first if you have not already. Docker Desktop and Podman Desktop will offer to do that for you during setup.',
        commands: ['wsl --install', 'winget install Docker.DockerDesktop'],
        links: [DOCS.dockerDesktop, DOCS.podmanDesktop, DOCS.rancher, DOCS.wslInstall],
      };
    case 'darwin':
      return {
        id: 'install-engine-darwin',
        severity: 'error',
        title: 'No container engine is installed',
        body: 'boxwarden found no container engine on this machine. macOS has no Linux kernel of its own, so each of these runs one in a lightweight VM for you.',
        commands: [
          'brew install --cask docker',
          'brew install --cask orbstack',
          'brew install colima docker && colima start',
        ],
        links: [DOCS.dockerDesktop, DOCS.orbstack, DOCS.colima, DOCS.rancher, DOCS.podmanDesktop],
      };
    case 'linux':
      return {
        id: 'install-engine-linux',
        severity: 'error',
        title: 'No container engine is installed',
        body: 'boxwarden found no container engine on this machine. Linux runs containers natively — Docker Engine or Podman is all you need, no VM involved. If one is already installed, it may just not be running or socket-activated.',
        commands: [
          'sudo systemctl enable --now docker',
          'systemctl --user enable --now podman.socket',
        ],
        links: [DOCS.dockerEngine, DOCS.podman, DOCS.devcontainers],
      };
    case 'other':
      return {
        id: 'install-engine-other',
        severity: 'error',
        title: 'No container engine is installed',
        body: 'boxwarden found no container engine on this machine, and does not recognise this platform well enough to suggest one. Any daemon speaking the Docker API will do — point boxwarden at it with the DOCKER_HOST environment variable.',
        commands: ['export DOCKER_HOST=unix:///var/run/docker.sock'],
        links: [DOCS.dockerEngine, DOCS.podman],
      };
  }
}

/**
 * The Windows-specific chain: WSL absent -> no distro -> nothing running.
 *
 * Returns at most one advisory, because these are stages of the same setup and
 * showing three at once would bury the one the user is actually at.
 */
function wslAdvice(
  environment: DockerEnvironment,
  anyEngineReachable: boolean,
): Advice | undefined {
  const { wsl } = environment;

  switch (wsl.kind) {
    case 'not-applicable':
      return undefined;

    case 'not-installed':
      // Only when nothing answered. An engine IS reachable without WSL on a
      // Docker Desktop running the Hyper-V backend or Windows containers —
      // unusual, entirely valid, and not something to nag about.
      if (anyEngineReachable) return undefined;
      return {
        id: 'wsl-not-installed',
        severity: 'error',
        title: 'WSL is not installed',
        body: 'Dev containers are Linux containers, and Linux containers on Windows need a Linux kernel to run in. WSL2 supplies it, and Docker Desktop, Podman and Rancher Desktop all run their engine inside it. Install WSL, reboot, then install a container engine.',
        commands: ['wsl --install'],
        links: [DOCS.wslInstall],
      };

    case 'no-distros':
      return {
        id: 'wsl-no-distros',
        severity: anyEngineReachable ? 'info' : 'error',
        title: 'WSL is installed but has no Linux distribution',
        body: 'WSL itself is present, but there is no distribution inside it for an engine to run in. Installing one takes a couple of minutes; Ubuntu is the default and the best-supported choice for dev containers.',
        commands: ['wsl --install -d Ubuntu'],
        links: [DOCS.wslInstall],
      };

    case 'none-running': {
      const first = wsl.installed[0] ?? 'Ubuntu';
      return {
        id: 'wsl-none-running',
        severity: anyEngineReachable ? 'info' : 'warning',
        title: 'No WSL distribution is running',
        body: `WSL has ${String(wsl.installed.length)} distribution${
          wsl.installed.length === 1 ? '' : 's'
        } installed (${wsl.installed.join(', ')}), none of them started. boxwarden will not start one for you — that is a slow and surprising thing for an app to do on its own — but an engine inside a stopped distro is invisible until it is up.`,
        commands: [`wsl -d ${first}`],
        links: [],
      };
    }

    case 'ready':
      return undefined;
  }
}

/**
 * Distros holding an engine boxwarden cannot reach for want of socat.
 *
 * Shown even when another engine IS reachable, and that is the point: the
 * symptom is a container list that looks fine and is quietly missing everything
 * in that distro. A user has no way to notice that on their own.
 */
function socatAdvice(environment: DockerEnvironment): Advice | undefined {
  const missing = distrosMissingSocat(environment.wsl);
  if (missing.length === 0) return undefined;

  const names = missing.map((distro) => distro.distro);
  return {
    id: 'wsl-socat-missing',
    severity: 'warning',
    title: `Cannot reach into ${names.join(', ')} — socat is missing`,
    body: 'WSL projects a distribution’s filesystem to Windows over 9P, and 9P cannot carry unix domain sockets. So an engine running inside a distro is invisible to Windows until something on the Linux side relays it, and boxwarden uses socat for that. Containers in these distributions will be missing from the list until it is installed.',
    commands: names.map((name) => `wsl -d ${name} -- sudo apt-get install -y socat`),
    links: [],
  };
}

/** Nothing answered, and the failures say why. */
function failureAdvice(input: AdviceInput): readonly Advice[] {
  const codes = failureCodes(input.environment);
  const advice: Advice[] = [];

  if (codes.has('permission-denied')) {
    advice.push({
      id: 'socket-permission-denied',
      severity: 'error',
      title: 'A container socket exists but boxwarden may not read it',
      body: 'The engine is installed and running. Your user account is not permitted to talk to it, which on Linux almost always means it is not in the "docker" group. Add it, then log out and back in — group membership is only picked up on a new login session.',
      commands: ['sudo usermod -aG docker "$USER"', 'newgrp docker'],
      links: [DOCS.dockerPostInstall],
    });
  }

  if (codes.has('connection-refused')) {
    advice.push({
      id: 'engine-not-running',
      severity: 'warning',
      title: 'A container engine is installed but not running',
      body: 'A socket is there and refusing connections, which means the engine is installed and stopped rather than missing. Start it and refresh.',
      commands:
        input.platform === 'win32'
          ? ['wsl --list --running']
          : input.platform === 'darwin'
            ? ['open -a Docker', 'colima start']
            : ['sudo systemctl start docker', 'systemctl --user start podman.socket'],
      links: [],
    });
  }

  if (codes.has('api-too-old')) {
    advice.push({
      id: 'api-too-old',
      severity: 'warning',
      title: 'The engine is too old',
      body: 'An engine answered but speaks an older Docker API than boxwarden needs. The floor is API 1.41 — Docker 20.10, released in 2020 — which is where health status on inspect became reliable. Upgrading the engine is the only fix.',
      commands: [],
      links: [DOCS.dockerEngine],
    });
  }

  return advice;
}

/**
 * How to have a working agent, per platform.
 *
 * The commands are the canonical recipe for that OS, not a diagnosis — they
 * are what a developer would be told to type by whoever they eventually asked.
 * The `note` is the part that recipe leaves out, and it is why each of these
 * is worth writing down rather than linking to: on Windows the agent people
 * start is usually the wrong one, on macOS the keys silently vanish at the
 * next reboot, and on Linux the agent dies with the shell that made it.
 */
const AGENT_SETUP: Readonly<
  Record<HostPlatform, { readonly commands: readonly string[]; readonly note: string }>
> = {
  win32: {
    commands: [
      'Get-Service ssh-agent',
      'Set-Service ssh-agent -StartupType Automatic',
      'Start-Service ssh-agent',
      'ssh-add $env:USERPROFILE\\.ssh\\id_ed25519',
    ],
    note: 'Run these in Windows PowerShell, not inside WSL. An ssh-agent started in a distro is a different agent from the Windows service, and the Dev Containers extension forwards the Windows one — keys added inside a distro never appear in the container, however correct the setup looks from in there.',
  },
  darwin: {
    commands: ['ssh-add --apple-use-keychain ~/.ssh/id_ed25519', 'ssh-add -l'],
    note: 'macOS always has an agent running under launchd, so the usual symptom is an agent with no keys in it rather than no agent. --apple-use-keychain is what makes that survive a reboot; adding "AddKeysToAgent yes" and "UseKeychain yes" under your Host entry in ~/.ssh/config is the same fix as a file rather than a command, and is the one that keeps working after the next OS update.',
  },
  linux: {
    commands: [
      'eval "$(ssh-agent -s)"',
      'ssh-add ~/.ssh/id_ed25519',
      'systemctl --user enable --now ssh-agent.service',
    ],
    note: 'The first form dies with the shell that started it and is invisible to every other one, which is why an agent that "was working a minute ago" is gone. The systemd --user unit (or your desktop keyring, if you have one) is the version worth setting up — it gives every session the same agent.',
  },
  other: {
    commands: ['ssh-add -l'],
    note: 'boxwarden does not recognise this platform well enough to say how agents are started on it. "ssh-add -l" answers the only question that matters: whether an agent is reachable and what it is holding.',
  },
};

/** What is wrong with the agent on this machine, or undefined when nothing is. */
type HostAgentProblem = 'service-disabled' | 'service-stopped' | 'no-agent' | 'socket-missing';

function hostAgentProblem(
  platform: HostPlatform,
  host: SshAgentHostProbe,
): HostAgentProblem | undefined {
  // Everything the probe read describes the container boxwarden is in, not the
  // machine the containers actually run on. There is nothing to conclude.
  if (host.inContainer) return undefined;

  switch (platform) {
    case 'win32':
      // `unknown` deliberately produces nothing: the probe could not read the
      // service, and inventing a problem from that is how an advisory panel
      // starts getting ignored.
      if (host.service === 'disabled') return 'service-disabled';
      if (host.service === 'stopped') return 'service-stopped';
      return undefined;
    case 'darwin':
    case 'linux':
      if (host.authSock === undefined) return 'no-agent';
      return host.authSockExists === false ? 'socket-missing' : undefined;
    case 'other':
      return undefined;
  }
}

function agentTitle(problem: HostAgentProblem | undefined, unmountedIn: readonly string[]): string {
  if (unmountedIn.length > 0) {
    return unmountedIn.length === 1
      ? `SSH agent forwarding is broken in ${unmountedIn[0] ?? ''}`
      : `SSH agent forwarding is broken in ${String(unmountedIn.length)} containers`;
  }
  switch (problem) {
    case 'service-disabled':
      return 'The Windows ssh-agent service is disabled';
    case 'service-stopped':
      return 'The Windows ssh-agent service is not running';
    case 'socket-missing':
      return 'SSH_AUTH_SOCK points at a socket that is not there';
    case 'no-agent':
    case undefined:
      return 'No SSH agent is running on this machine';
  }
}

function agentSituation(
  problem: HostAgentProblem | undefined,
  unmountedIn: readonly string[],
): string {
  if (unmountedIn.length > 0) {
    const which =
      unmountedIn.length === 1
        ? `${unmountedIn[0] ?? ''} sets`
        : `${unmountedIn.join(', ')} each set`;
    return `${which} SSH_AUTH_SOCK, and nothing is mounted at the path it names. The socket does not exist, so anything inside using SSH fails with "Could not open a connection to your authentication agent" — and because the variable is set, every check a developer knows how to make agrees the container is configured. Rebuild it with the Dev Containers extension, which forwards the agent for you, or add the socket to the volumes in your compose file alongside the variable.`;
  }
  switch (problem) {
    case 'service-disabled':
      return 'Windows ships the OpenSSH ssh-agent service disabled, so nothing is holding your keys and nothing will after a reboot either. Dev containers get their git credentials by having that agent forwarded into them, so this stops any container on this machine from reaching a private repo.';
    case 'service-stopped':
      return 'The OpenSSH ssh-agent service is installed and stopped. Dev containers get their git credentials by having it forwarded into them, so nothing on this machine can reach a private repo until it is running.';
    case 'socket-missing':
      return 'SSH_AUTH_SOCK is set in boxwarden’s environment but there is nothing at that path, which is what a stale agent socket left over from a previous login session looks like. Anything reading it — including anything you forward into a container — is pointing at a socket that has gone.';
    case 'no-agent':
    case undefined:
      return 'No SSH agent is reachable from here, so there are no keys to forward into a dev container. Containers that need to reach a private repo will fail at the first fetch.';
  }
}

/**
 * SSH agent forwarding: what is wrong here, and what to type.
 *
 * SEVERITY IS NEVER `error`, and that is a rule rather than a judgement call.
 * Plenty of dev containers have no business talking to a remote, and an
 * advisory that nags every developer who does not need SSH is worse than no
 * advisory — it teaches people to skip the panel that will one day be telling
 * them something urgent.
 *
 * `warning` is reserved for a container in front of the user that declares a
 * socket it does not have, because that one is invisible from the inside.
 * Everything else is `info`.
 */
export function adviseSshAgent(
  platform: HostPlatform,
  input: SshAgentAdviceInput | undefined,
): Advice | undefined {
  if (input === undefined) return undefined;

  const { host, unmountedIn } = input;
  const problem = hostAgentProblem(platform, host);
  // Nothing broken in a container, and nothing wrong with the host agent —
  // which includes the case where we could not tell. Say nothing.
  if (unmountedIn.length === 0 && problem === undefined) return undefined;

  const setup = AGENT_SETUP[platform];
  const body = [
    agentSituation(problem, unmountedIn),
    setup.note,
    host.inContainer
      ? 'boxwarden is itself running inside a container, so it cannot see whether an agent is running on your machine — it only checked the container it is in. Run the commands below on the host, in the same session you start your editor from.'
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return {
    id: unmountedIn.length > 0 ? 'ssh-agent-declared-unmounted' : 'ssh-agent-host',
    severity: unmountedIn.length > 0 ? 'warning' : 'info',
    title: agentTitle(problem, unmountedIn),
    body,
    commands: setup.commands,
    links:
      platform === 'win32' ? [DOCS.sshInContainers, DOCS.windowsSshKeys] : [DOCS.sshInContainers],
  };
}

/**
 * Everything worth telling the user about this environment, most urgent first.
 *
 * Order is severity then specificity: an error about WSL comes before the
 * generic install menu, because the install menu is useless until WSL exists.
 */
export function adviseEnvironment(input: AdviceInput): readonly Advice[] {
  const { environment, platform, selection } = input;
  const engines = enginesFrom(environment);
  const anyEngineReachable = engines.length > 0;
  const advice: Advice[] = [];

  // First, because it is the one case where the app looks broken and nothing
  // is: engines are reachable, the user narrowed to one, and that one went away.
  if (anyEngineReachable && !selectionIsReachable(selection, engines)) {
    advice.push({
      id: 'selected-engine-unreachable',
      severity: 'warning',
      title: 'The engine you selected is not answering',
      body: `boxwarden is set to use one specific engine, and it did not respond to this scan. ${String(
        engines.length,
      )} other engine${engines.length === 1 ? ' is' : 's are'} reachable. Switch the engine picker back to "All engines" to see them, or start the one you chose.`,
      commands: [],
      links: [],
    });
  }

  const wsl = wslAdvice(environment, anyEngineReachable);
  if (wsl !== undefined) advice.push(wsl);

  if (!anyEngineReachable) {
    advice.push(...failureAdvice(input));

    // The install menu goes last among the errors. If WSL is missing on
    // Windows, or a socket is refusing, that is the more specific answer and
    // this would only be noise above it.
    const nothingButAbsence = [...failureCodes(environment)].every(
      (code) => code === 'not-present' || code === 'unknown' || code === 'timeout',
    );
    if (nothingButAbsence) advice.push(installOptions(platform));
  }

  const socat = socatAdvice(environment);
  if (socat !== undefined) advice.push(socat);

  // Below the engine-level advisories on purpose. Agent forwarding only
  // matters once boxwarden can see containers at all, and it is never the
  // reason the app looks broken.
  const ssh = adviseSshAgent(platform, input.sshAgent);
  if (ssh !== undefined) advice.push(ssh);

  // Lowest priority, and only once the important things are working: the CLI
  // gates features that do not exist yet, so it is a note and never a warning.
  if (anyEngineReachable && !environment.cli.ok) {
    advice.push({
      id: 'docker-cli-missing',
      severity: 'info',
      title: 'The docker command is not on your PATH',
      body: `Nothing boxwarden does today needs it (${environment.cli.code}) — listing, starting and opening containers all go over the API socket. Rebuilding and creating containers will need it, because those shell out to the devcontainer CLI.`,
      commands: [],
      links: [DOCS.devcontainers],
    });
  }

  return advice;
}
