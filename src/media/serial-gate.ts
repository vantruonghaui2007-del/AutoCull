/** One process-wide slot; failures must not poison the next caller's turn. */
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const current = this.tail.then(work);
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }
}
