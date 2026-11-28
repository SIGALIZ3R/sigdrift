import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** True when the run collects coverage (see vite.config.ts): timing benchmarks skip themselves. */
    coverage: boolean;
  }
}
