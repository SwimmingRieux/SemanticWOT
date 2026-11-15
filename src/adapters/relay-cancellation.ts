/** Remove completed waits immediately; a workflow may execute thousands of pages. */
export function createRelayCancellation() {
  let stopped = false;
  const pending = new Set<() => void>();
  return {
    run<T>(operation: () => Promise<T>, ended: () => T): Promise<T> {
      if (stopped) return Promise.resolve(ended());
      return new Promise<T>((resolve, reject) => {
        const cancel = () => { pending.delete(cancel); resolve(ended()); };
        pending.add(cancel);
        try {
          operation().then(value => { pending.delete(cancel); resolve(value); }, error => { pending.delete(cancel); reject(error); });
        } catch (error) { pending.delete(cancel); reject(error); }
      });
    },
    stop() { stopped = true; for (const cancel of pending) cancel(); },
  };
}
