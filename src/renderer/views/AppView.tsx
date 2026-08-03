import { UpdateBanner } from '../components/UpdateBanner.js';
import { relativeTime } from '../format.js';
import { containerCountLabel } from '../presenters.js';
import type { AppViewModel } from '../viewmodels/index.js';
import { AppFooter } from './AppFooter.js';
import { AppHeader } from './AppHeader.js';
import { BridgeMissing } from './BridgeMissing.js';
import { ContainersView } from './ContainersView.js';
import { NoticeBar } from './NoticeBar.js';
import { SetupView } from './SetupView.js';

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
 *
 * The header, the notice bar and the footer are shared by both screens; the one
 * expression inside the scroller chooses between them. Which screen is showing
 * is a ViewModel field (`advisories.page`), not state kept here.
 */
export function AppView({ vm }: Props) {
  const { notices, theme, editors, terminals, discovery, advisories, update, now } = vm;

  if (!vm.bridgeAvailable) return <BridgeMissing />;

  const scannedLabel =
    discovery.snapshot === undefined
      ? undefined
      : `scanned ${relativeTime(discovery.snapshot.scannedAt, now)}`;

  return (
    <main className="app">
      <AppHeader
        engines={discovery.snapshot?.engines}
        selection={discovery.snapshot?.selection}
        engine={discovery.engine}
        pickerDisabled={discovery.anyBusy}
        page={advisories.page}
        setup={advisories.badge}
        onNavigate={advisories.navigate}
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
        {/*
         * Above whichever screen is showing, because it is about the app
         * rather than about this machine's containers — the same reason the
         * footer's version line is shared by both screens. Inside the scroller
         * rather than pinned beside the notice bar, so it scrolls away instead
         * of standing over the list.
         *
         * `panel` is undefined whenever there is nothing to say, which is
         * almost always, so this costs the screen nothing the rest of the time.
         */}
        {update.panel !== undefined && (
          <UpdateBanner
            panel={update.panel}
            busy={update.busy}
            onDismiss={update.dismiss}
            onDisable={update.disable}
          />
        )}

        {advisories.page === 'setup' ? (
          <SetupView
            advisories={advisories}
            environment={discovery.snapshot?.environment}
            scannedLabel={scannedLabel}
          />
        ) : (
          <ContainersView vm={vm} />
        )}
      </div>

      <AppFooter
        countLabel={containerCountLabel(discovery.containers.length)}
        scannedLabel={scannedLabel}
        view={theme.view}
        onChangeView={theme.changeView}
        editors={editors.editors}
        editorId={editors.editorId}
        onChooseEditor={editors.chooseEditor}
        terminals={terminals.terminals}
        terminalId={terminals.terminalId}
        showTerminalPicker={terminals.anyAvailable}
        onChooseTerminal={terminals.chooseTerminal}
        update={update.summary}
        updateBusy={update.busy}
        onUpdateAction={update.act}
      />
    </main>
  );
}
