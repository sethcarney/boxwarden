import { Advisories } from '../components/Advisories.js';
import { DockerUnavailable } from '../components/DockerUnavailable.js';
import { UnbuiltProjects } from '../components/UnbuiltProjects.js';
import type { AppViewModel } from '../viewmodels/index.js';
import { ContainerList } from './ContainerList.js';
import { NoContainers } from './NoContainers.js';

interface Props {
  readonly vm: AppViewModel;
}

/**
 * The main screen: advice, diagnostics, the container list, and the projects
 * that have never been built.
 *
 * Split out of `AppView` when the setup page arrived, so that the root view
 * stayed what it says it is — a header, a scroller, a footer, and one
 * expression choosing which screen goes in the middle. Everything here was
 * already in `AppView`; the only change is that the advisories it renders are
 * the ACTIVE ones, with a Hide button that moves a card to the other screen.
 */
export function ContainersView({ vm }: Props) {
  const {
    theme,
    editors,
    terminals,
    discovery,
    projects,
    activity,
    git,
    branches,
    advisories,
    now,
  } = vm;

  return (
    <>
      {discovery.loading && <p className="empty">Looking for a container engine…</p>}

      {/*
       * Above the diagnostics and above the list, and shown even when
       * everything is working. Most of these advisories are about containers
       * the user CANNOT see — a WSL distro with no relay into it produces a
       * list that looks complete and is not — so hiding them behind a failure
       * state would hide them exactly when they matter.
       *
       * `active` rather than the whole list, because the user can now put one
       * away. Nothing is lost by that: the header's Setup tab counts what is
       * left and the setup page lists both halves in full.
       */}
      <Advisories advice={advisories.active} onHide={advisories.hide} />

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
        claudeFor={activity.claudeFor}
        claudeForAll={activity.claudeForAll}
        editorFor={activity.editorFor}
        editorsForAll={activity.editorsForAll}
        gitFor={git.statusFor}
        branchMenuFor={branches.bindingFor}
        onStart={discovery.start}
        onStop={discovery.stop}
        onOpen={discovery.open}
        onOpenTerminal={discovery.openTerminal}
        onStartupCommandChange={terminals.setStartupCommand}
        onStartAll={discovery.startAll}
        onStopAll={discovery.stopAll}
      />

      {/*
       * Below the built containers, because a container you can open right now
       * outranks a folder you would have to build first — but on the same
       * screen, since the whole point is that "no dev containers found" is not
       * the end of the story.
       */}
      <UnbuiltProjects
        projects={projects}
        editorName={editors.editorName}
        editorAvailable={editors.editorAvailable}
        now={now}
      />
    </>
  );
}
