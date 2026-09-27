import { useEffect, useState } from "react";
import {
  applyTypePreference,
  loadTypePreference,
  storeTypePreference,
  TYPE_FAMILIES,
  TYPE_WEIGHTS,
  type TypePreference,
} from "@/features/appearance/typePreferences";

/**
 * The face and weight the panel is set in, as two controls in the surface bar.
 *
 * Native `<select>`s rather than a built menu, for three reasons that all bite here: the bar is
 * a horizontally scrolling flex row, so an absolutely positioned popup would be clipped by its
 * own scroller; the phone gets its own wheel picker for free; and keyboard and screen-reader
 * behaviour arrives correct rather than reimplemented.
 *
 * The write happens in one effect on the value rather than beside each change, which is what
 * keeps a later third caller from being the one that forgets to persist.
 */
export function TypeControls(): React.ReactElement {
  const [type, setType] = useState<TypePreference>(loadTypePreference);

  useEffect(() => {
    applyTypePreference(document.documentElement, type);
    storeTypePreference(type);
  }, [type]);

  const select =
    "min-h-8 shrink-0 cursor-pointer rounded-md bg-transparent px-1 py-1 " +
    "text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground " +
    "outline-none transition-colors hover:bg-muted/60 hover:text-foreground " +
    "focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div role="group" aria-label="Panel type" className="flex shrink-0 items-center self-center">
      <select
        id="agent-panel-type-family"
        aria-label="Typeface"
        title="The face this panel is set in. Remembered in this browser."
        value={type.family}
        onChange={(event) => setType((was) => ({ ...was, family: event.target.value }))}
        className={select}
      >
        {TYPE_FAMILIES.map((family) => (
          <option key={family.id} value={family.id}>
            {family.label}
          </option>
        ))}
      </select>
      <select
        id="agent-panel-type-weight"
        aria-label="Text weight"
        title="The weight of ordinary text. Every heavier step moves with it."
        value={type.weight}
        onChange={(event) => setType((was) => ({ ...was, weight: Number(event.target.value) }))}
        className={select}
      >
        {TYPE_WEIGHTS.map((weight) => (
          <option key={weight} value={weight}>
            {weight}
          </option>
        ))}
      </select>
    </div>
  );
}
