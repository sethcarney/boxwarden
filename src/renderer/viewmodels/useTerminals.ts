import { useCallback, useEffect, useState } from 'react';
import type { DevContainer, TerminalId } from '../../models/index.js';
import { containerSettingsKey } from '../../models/index.js';
import type { BoxwardenApi, TerminalOption } from '../../shared/ipc.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

export interface TerminalsViewModel {
  readonly terminals: readonly TerminalOption[];
  /** Undefined when no emulator this app recognises was found. */
  readonly terminalId: TerminalId | undefined;
  readonly selectedTerminal: TerminalOption | undefined;
  /**
   * The emulator's name for a label, or undefined when there is none to name.
   *
   * Undefined is a different sentence from "Konsole was not found": there is no
   * name to blame, and telling the user to install something they never chose
   * would be nonsense.
   */
  readonly terminalName: string | undefined;
  readonly terminalAvailable: boolean;
  /** Whether the footer picker is worth showing at all. */
  readonly anyAvailable: boolean;
  readonly chooseTerminal: (id: TerminalId) => void;
  /** '' when none is set — the card's input is controlled either way. */
  readonly startupCommandFor: (container: DevContainer) => string;
  readonly setStartupCommand: (container: DevContainer, command: string) => void;
}

/**
 * Which terminal emulators are installed, which one to use, and the startup
 * command each container runs in it.
 *
 * The two halves share a ViewModel because they are one feature: the startup
 * command exists to be run when a terminal opens, and nothing else reads it.
 *
 * Both are read once. The set of emulators on a machine does not change while
 * the app is open, and the main process holds the authoritative startup
 * commands — this hook is what tells it to change them, so re-reading on the
 * five-second poll would cost a round trip to learn what it just said.
 *
 * OPENING a terminal is deliberately not here: it marks a container busy and
 * shares that state with Start, Stop and Open, so it lives in `useDiscovery`
 * with them. Two independent busy sets would let one re-enable a button the
 * other still considers busy.
 */
export function useTerminals(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
): TerminalsViewModel {
  const [terminals, setTerminals] = useState<readonly TerminalOption[]>([]);
  const [terminalId, setTerminalId] = useState<TerminalId | undefined>(undefined);
  const [startupCommands, setStartupCommands] = useState<Readonly<Record<string, string>>>({});
  const mounted = useMounted();

  const { showError, showThrown } = notices;

  useEffect(() => {
    if (api === undefined) return;
    void api.listTerminals().then(
      (found) => {
        if (!mounted.current) return;
        setTerminals(found);
        // No fixed default to fall back on, unlike editors: there is no
        // terminal emulator every machine has. The probe order in
        // src/main/terminal/targets.ts IS the preference order, so the first
        // available entry is the answer — and undefined when there is none,
        // which disables the action with a reason rather than offering a dead
        // button.
        setTerminalId(found.find((terminal) => terminal.available)?.id);
      },
      () => {
        // Same reasoning as the editor list: the per-card hint already explains
        // a disabled Terminal button, and a notice here would fire before the
        // user has done anything.
      },
    );
  }, [api, mounted]);

  useEffect(() => {
    if (api === undefined) return;
    void api.getStartupCommands().then(
      (found) => {
        if (mounted.current) setStartupCommands(found);
      },
      () => {
        // An unreadable preferences file means no startup commands, which is
        // also exactly what a first run looks like. Nothing to say.
      },
    );
  }, [api, mounted]);

  const chooseTerminal = useCallback((id: TerminalId) => {
    setTerminalId(id);
  }, []);

  const startupCommandFor = useCallback(
    (container: DevContainer) => startupCommands[containerSettingsKey(container)] ?? '',
    [startupCommands],
  );

  /**
   * Written through to the main process and mirrored locally on success.
   *
   * Deliberately not routed through the busy set: that disables the card's
   * controls and forces a Docker re-read, neither of which a text field
   * deserves. The local mirror is what keeps the value on screen after the
   * input loses focus, since the card's own draft state stops tracking it then.
   *
   * The key is computed here only to update the mirror. The bridge is sent the
   * container's ID, and the main process derives the key again from its own
   * copy — a renderer cannot file a startup command against a folder it
   * invented.
   */
  const setStartupCommand = useCallback(
    (container: DevContainer, command: string) => {
      if (api === undefined) return;
      const key = containerSettingsKey(container);
      void api.setStartupCommand(container.id, command).then(
        (result) => {
          if (!mounted.current) return;
          if (result.ok) {
            // Trimmed to match what the main process stored, so the field does
            // not keep whitespace the preferences file does not have.
            setStartupCommands((current) => ({ ...current, [key]: command.trim() }));
          } else {
            showError(result.message);
          }
        },
        (error: unknown) => {
          showThrown(error);
        },
      );
    },
    [api, mounted, showError, showThrown],
  );

  const selectedTerminal = terminals.find((terminal) => terminal.id === terminalId);

  return {
    terminals,
    terminalId,
    selectedTerminal,
    terminalName: selectedTerminal?.displayName,
    terminalAvailable: selectedTerminal?.available ?? false,
    anyAvailable: terminals.some((terminal) => terminal.available),
    chooseTerminal,
    startupCommandFor,
    setStartupCommand,
  };
}
