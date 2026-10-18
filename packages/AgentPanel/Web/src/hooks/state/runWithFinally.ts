// `try`/`finally`, for the async work a component or hook starts.
//
// React Compiler cannot compile a function holding a `finally` clause yet, and skips the whole
// component or hook around it, so the clause lives here, in a plain function the compiler does not
// touch. `work` keeps its own `try`/`catch` (which it can compile), its early returns and its
// rethrows; `cleanup` runs once however `work` ended, exactly as a `finally` would, and what `work`
// resolved or threw is what the caller gets.

export async function runWithFinally<T>(work: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await work();
  } finally {
    cleanup();
  }
}
