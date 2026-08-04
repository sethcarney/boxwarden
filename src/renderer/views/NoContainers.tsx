interface Props {
  /** Why the list is empty, from the ViewModel — it depends on the engine selection. */
  readonly message: string;
}

/** Docker answered and there is simply nothing carrying the label. */
export function NoContainers({ message }: Props) {
  return (
    <section className="panel">
      <h2>No dev containers found</h2>
      <p className="lede">{message}</p>
      <p className="note">
        boxwarden only lists containers created by the Dev Containers extension or the
        <code> devcontainer </code> CLI. Ordinary containers are deliberately not shown.
      </p>
    </section>
  );
}
