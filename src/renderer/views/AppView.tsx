import { Advisories } from '../components/Advisories.js';
import { DockerUnavailable } from '../components/DockerUnavailable.js';
import { UnbuiltProjects } from '../components/UnbuiltProjects.js';
import { relativeTime } from '../format.js';
import { containerCountLabel } from '../presenters.js';
import type { AppViewModel } from '../viewmodels/index.js';
import { AppFooter } from './AppFooter.js';
import { AppHeader } from './AppHeader.js';
import { BridgeMissing } from './BridgeMissing.js';
import { ContainerList } from './ContainerList.js';
import { NoContainers } from './NoContainers.js';
import { NoticeBar } from './NoticeBar.js';

interface Props {
  readonly vm: AppViewModel;
}

/**
 * The root View: layout and binding, no state and no logic.
 *
 * Everything rendered here is either a value the ViewModel already derived or a
 * callback it exposes. The rule for this file is that nothing computes — if a
 * string needs an `if`, it belongs in `presenters.ts` and reaches this file
 * through a ViewModel field.
 */
export function AppView({ vm }: Props) {
  const { notices, theme, editors, terminals, discovery, projects, claude, now } = vm;

  if (!vm.bridgeAvailable) return <BridgeMissing />;

  return (
    <main className="app">
      <AppHeader
        engines={discovery.snapshot?.engines}
        selection={discovery.snapshot?.selection}
        engine={discovery.engine}
        pickerDisabled={discovery.anyBusy}
        onSelectEngine={discovery.selectEngine}
        onRefresh={discovery.refresh}
      />

      <NoticeBar
        notice={notices.notice}
        fallback={notices.fallback}
        onCopy={notices.copyFallback}
        onDismiss={notices.dismiss}
      />

      {/*
       * One scroller for everything between the header and the footer.
       *
       * The list used to be the flex child that grew, which pinned the
       * "Not built yet" panel to the bottom edge and opened a lake of empty
       * space between them on any window taller than three cards. Everything
       * scrolls together now, and the panel sits directly under the last card.
       */}
      <div className="content">
        {discovery.loading && <p className="empty">Looking for a container engine…</p>}

        {/*
         * Above the diagnostics and above the list, and shown even when
         * everything is working. Most of these advisories are about containers
         * the user CANNOT see — a WSL distro with no relay into it produces a
         * list that looks complete and is not — so hiding them behind a failure
         * state would hide them exactly when they matter.
         */}
        {discovery.snapshot !== undefined && <Advisories advice={discovery.snapshot.advice} />}

        {discovery.snapshot !== undefined && !discovery.dockerOk && (
          <DockerUnavailable environment={discovery.snapshot.environment} />
        )}

        {discovery.snapshot !== undefined &&
          discovery.dockerOk &&
          discovery.containers.length === 0 && <NoContainers message={discovery.emptyMessage} />}

        <ContainerList
          groups={discovery.groups}
          layout={theme.view.layout}
          editorId={editors.editorId}
          editorName={editors.editorName}
          editorAvailable={editors.editorAvailable}
          terminalName={terminals.terminalName}
          terminalAvailable={terminals.terminalAvailable}
          startupCommandFor={terminals.startupCommandFor}
          now={now}
          isBusy={discovery.isBusy}
          isGroupBusy={discovery.isGroupBusy}
          claudeFor={claude.statusFor}
          claudeForAll={claude.statusesFor}
          onStart={discovery.start}
          onStop={discovery.stop}
          onOpen={discovery.open}
          onOpenTerminal={discovery.openTerminal}
          onStartupCommandChange={terminals.setStartupCommand}
          onStartAll={discovery.startAll}
          onStopAll={discovery.stopAll}
        />

        {/*
         * Below the built containers, because a container you can open right
         * now outranks a folder you would have to build first — but on the same
         * screen, since the whole point is that "no dev containers found" is
         * not the end of the story.
         */}
        <UnbuiltProjects
          projects={projects}
          editorName={editors.editorName}
          editorAvailable={editors.editorAvailable}
          now={now}
        />
      </div>

      <AppFooter
        countLabel={containerCountLabel(discovery.containers.length)}
        scannedLabel={
          discovery.snapshot === undefined
            ? undefined
            : `scanned ${relativeTime(discovery.snapshot.scannedAt, now)}`
        }
        view={theme.view}
        onChangeView={theme.changeView}
        editors={editors.editors}
        editorId={editors.editorId}
        onChooseEditor={editors.chooseEditor}
        terminals={terminals.terminals}
        terminalId={terminals.terminalId}
        showTerminalPicker={terminals.anyAvailable}
        onChooseTerminal={terminals.chooseTerminal}
      />
    </main>
  );
}
