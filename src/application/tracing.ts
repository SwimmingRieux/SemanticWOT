/** Optional observation capability; the application has no dependency on a telemetry SDK. */
export interface TraceRunner {
  run<T>(name: string, attributes: Record<string, string | number | boolean>, operation: () => Promise<T>): Promise<T>;
}
export const untraced: TraceRunner = { run: (_name, _attributes, operation) => operation() };
