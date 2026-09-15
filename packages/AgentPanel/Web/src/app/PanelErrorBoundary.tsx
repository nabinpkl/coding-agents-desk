"use client";

// What the reader sees when a render throws, instead of an empty page.
//
// React unmounts the whole tree when nothing catches, so one bad module anywhere -- a component
// edited mid-save, a wire shape that changed under a stale caller -- takes the entire panel down
// to white. The page then says nothing at all: not what broke, not that anything broke, and not
// that reloading is the way back. Every surface here mounts under one of these instead.
//
// Under a dev server it also heals itself. The failure this is built for is temporal: the tree was
// broken for as long as it took the next save to land, and the boundary was holding a dead screen
// long after the code behind it was fine again. So an applied update clears the error and re-renders
// rather than waiting for somebody to reach for the reload button.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { devServerHooks } from "@/features/profile/panelBuild";

const CONTROL_CLASS =
  "rounded-md border border-border px-3 py-1.5 font-medium outline-none transition-colors " +
  "hover:border-primary hover:text-primary focus-visible:border-primary focus-visible:ring-2 " +
  "focus-visible:ring-primary active:opacity-70";

interface Props {
  children: ReactNode;
  /** Which surface this is wrapping, for the reader who has more than one open. */
  surface: string;
  /** The seam: `import.meta.hot` in production, a stand-in under Vitest, absent in a bundle. */
  devServer?: unknown;
}

interface State {
  error: Error | null;
  /** Where React said it threw. Worth more than the stack, which is all framework frames. */
  stack: string | null;
}

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };
  /**
   * Resolved in the constructor rather than on mount, because a child that throws on its FIRST
   * render draws the fallback before `componentDidMount` runs, and the fallback says whether it
   * will heal itself.
   */
  private hot = devServerHooks(this.props.devServer ?? import.meta.hot);

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidMount(): void {
    this.hot?.on("vite:afterUpdate", this.retry);
  }

  componentWillUnmount(): void {
    this.hot?.off("vite:afterUpdate", this.retry);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept out of state and on the console as well, because a boundary that swallows the stack
    // makes itself the thing that has to be debugged.
    console.error(`[panel] ${this.props.surface} threw`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  /** Clears the error so the children mount again. Still-broken code simply throws back into here. */
  private retry = (): void => {
    this.setState({ error: null, stack: null });
  };

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-background p-4 text-foreground">
        <div className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-card p-4">
          <h1 className="text-base font-semibold">The {this.props.surface} stopped rendering</h1>
          <p className="font-mono text-sm break-words text-destructive">
            {error.message || String(error)}
          </p>
          {stack ? (
            <pre className="max-h-40 overflow-auto rounded-sm bg-muted p-2 font-mono text-xs text-muted-foreground">
              {stack.trim()}
            </pre>
          ) : null}
          <div className="flex items-center gap-3 text-sm">
            <button type="button" className={CONTROL_CLASS} onClick={this.retry}>
              Try again
            </button>
            <button
              type="button"
              className={CONTROL_CLASS}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            {this.hot ? (
              <span className="text-muted-foreground">Clears itself on the next update.</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}
