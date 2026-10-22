// The Profile menu's way to Agent Radio, the audio channel's own page (`public/listen.html`).
//
// A link: listening on that page is what a panel reload cannot stop, and on the iPhone the page is
// installed to the Home Screen as an app of its own. Opened in a new tab so the panel stays where it
// was. Listening in the panel itself is the entry beside it (`ListenHereMenuItem`), which a reload
// does end.

import { ExternalLink, Radio } from "lucide-react";
import { PROFILE_MENU_ITEM_CLASS } from "@/features/profile/PushMenuItems";

/** Where Agent Radio is served, as its manifest's `start_url` names it. */
const AGENT_RADIO_URL = "/listen.html";

export function AgentRadioMenuItem() {
  return (
    <a role="menuitem" href={AGENT_RADIO_URL} target="_blank" rel="noopener" className={PROFILE_MENU_ITEM_CLASS}>
      <Radio className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Agent Radio</span>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </a>
  );
}
