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
//
// One boundary at the root made one bad card cost the whole panel: a single session card reading a
// field the sidecar had just stopped sending blanked every Bot, the sidebar and the tab bar with it,
// which also took away the way to look at anything else. So boundaries sit at every place a reader
// can lose one thing and keep the rest -- each tab's surface, the sidebar, the canvas, each Bot and
// each session card -- and the root one stays for what is left. `compact` is the fallback sized for
// a card rather than a screen; `listItem` makes it an `<li>`, for a card that is one in a list.

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
  /** A card-sized fallback, for a boundary around one thing among many rather than a whole screen. */
  compact?: boolean;
  /** Render the fallback as an `<li>`, because what it stands in for was one. */
  listItem?: boolean;
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
    if (this.props.compact) return this.renderCompact(error, stack);

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
          {this.renderActions("text-sm")}
        </div>
      </div>
    );
  }

  /** In place of one card: what broke, with the stack folded away, since the card is narrow. */
  private renderCompact(error: Error, stack: string | null): ReactNode {
    const Root = this.props.listItem ? "li" : "div";
    return (
      <Root
        role="alert"
        className="w-80 max-w-full shrink-0 space-y-2 self-start rounded-lg border border-destructive bg-card p-3 text-foreground"
      >
        <p className="text-sm font-semibold">The {this.props.surface} stopped rendering</p>
        <p className="font-mono text-xs break-words text-destructive">{error.message || String(error)}</p>
        {stack ? (
          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary">
              Where it threw
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-sm bg-muted p-2 font-mono text-muted-foreground">
              {stack.trim()}
            </pre>
          </details>
        ) : null}
        {this.renderActions("flex-wrap text-xs")}
      </Root>
    );
  }

  private renderActions(sizing: string): ReactNode {
    return (
      <div className={`flex items-center gap-3 ${sizing}`}>
        <button type="button" className={CONTROL_CLASS} onClick={this.retry}>
          Try again
        </button>
        <button type="button" className={CONTROL_CLASS} onClick={() => window.location.reload()}>
          Reload
        </button>
        {this.hot ? <span className="text-muted-foreground">Clears itself on the next update.</span> : null}
      </div>
    );
  }
}
