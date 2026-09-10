// What the sidecar's terminal stream says, and what it does to the screen.
//
// Every branch here writes through the same queue, so a checkpoint that clears and repaints
// cannot interleave with the frames arriving behind it.

import type { AgentTerminalStreamMessage } from "@agentdesk/agent-feed-wire";
import type { TerminalRuntime } from "@/features/terminal/mounted-terminal/agentTerminalRuntime";

export function createTerminalReceive(t: TerminalRuntime) {
  return (message: AgentTerminalStreamMessage): void => {
    switch (message.type) {
      case "checkpointBegin":
        t.setSyncLabel("Synchronizing");
        t.setSourceLabel(`Source ${message.columns}×${message.rows}`);
        t.enqueueWrite(() => {
          t.terminal.clear();
          t.terminal.reset();
          t.terminal.resize(message.columns, message.rows);
          // A new grid is a new shape to fit the type to, and a new height for the pane to
          // want. Nothing else reports this: the mount has not moved.
          t.fitType();
        });
        break;
      case "checkpointChunk":
      case "output":
        t.write(message.data);
        break;
      case "checkpointEnd":
        t.enqueueWrite(() => {
          t.setSyncLabel(`Revision ${message.revision}`);
          t.scheduleViewport();
        });
        break;
      case "viewport": {
        // A follower never reports controlling the layout, even where the shapes happen to
        // agree: it did not ask for this one and will not keep it if the pane moves. Braced
        // because a declaration in a bare `case` shares the whole switch's scope.
        const controls = message.isOwner && t.adoptsPaneShape;
        t.setOwnershipLabel(
          // Three different things, and a follower is not the third: "frozen" is a pane that
          // would not take a shape it was ASKED for, which is a fault worth reading, where
          // this one is a surface that deliberately never asks.
          controls
            ? "Controls layout"
            : !t.adoptsPaneShape
              ? "Follows the pane"
              : message.ownerClientId !== "0"
                ? `Following ${message.ownerTitle || "viewer"}`
                : "Source frozen",
        );
        t.setSourceLabel(`Source ${message.sourceColumns}×${message.sourceRows}`);
        t.setViewLabel(`View ${message.viewColumns}×${message.viewRows}`);
        // Which of the two fits is in force, and it can change under a viewer: a pane stops
        // being ours the moment somebody attaches a terminal to it, and starts being ours
        // again when they leave. Re-fit on the change so the type moves with it rather than
        // staying at whatever the other regime left behind.
        if (t.paneAuthoritative && controls !== t.ownsPaneShape) {
          t.ownsPaneShape = controls;
          t.enqueueWrite(() => t.fitType());
        }
        break;
      }
      case "exited":
        t.finishRemote({ kind: "ended", exitStatus: message.status });
        break;
      case "detached":
        t.finishRemote({ kind: "ended" });
        break;
      case "error":
        t.remoteClosed = true;
        t.unsubscribe?.();
        t.unsubscribe = null;
        t.fail(new Error(message.message));
        break;
    }
  };
}
