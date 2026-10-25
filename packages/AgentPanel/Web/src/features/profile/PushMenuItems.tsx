import { useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { enableNotifications, pushReadiness, sendTestNotification } from "@/features/profile/webPush";

const ITEM_CLASS = `flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm
  transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent/80
  focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2
  focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-muted-foreground
  disabled:hover:bg-transparent`;

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Profile menu's notification entries: turn web push on for this browser, and send a test.
 *
 * Kept open on purpose after a press: each says what happened in place, because the answer (a
 * prompt refused, a push service's status) is the point of pressing it, and a menu that closed
 * would throw it away.
 */
export function PushMenuItems() {
  const [readiness, setReadiness] = useState(pushReadiness);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const unsupported = readiness === "unsupported";

  const run = (work: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    work()
      .then(setStatus, (error: unknown) => setStatus(failure(error)))
      .finally(() => {
        setBusy(false);
        setReadiness(pushReadiness());
      });
  };

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-disabled={unsupported || busy}
        disabled={unsupported || busy}
        onClick={() => run(() => enableNotifications().then(() => "notifications on"))}
        className={ITEM_CLASS}
      >
        <Bell className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Enable notifications</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {unsupported ? "install to Home Screen" : readiness}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        aria-disabled={readiness !== "granted" || busy}
        disabled={readiness !== "granted" || busy}
        onClick={() => run(sendTestNotification)}
        className={ITEM_CLASS}
      >
        <BellRing className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Send test notification</span>
      </button>
      {status ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs break-words text-muted-foreground">
          {status}
        </p>
      ) : null}
    </>
  );
}
