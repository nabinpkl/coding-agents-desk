// The mark on a file row.
//
// The icons are the material-icon-theme set, subsetted to 91 families and committed as data
// (`fileIcons.json`, MIT, see `LICENSE.material-icon-theme`). They carry their own colours, which
// is the whole point of having them: a tree of one grey page repeated says nothing about what is
// in it, and colour is what makes a language findable by eye before the name is read.
//
// Data rather than a dependency, and JSON rather than TypeScript. The table is generated output
// with no logic in it, so `.json` keeps it out of the 500-line cap that governs source, where a
// 1200-line `.ts` of SVG paths would fail check 5 for being long without being complex.

import iconTable from "@/features/workspace-ide/sidebar/fileIcons.json";

interface IconShape {
  viewBox: string;
  body: string;
}

const SHAPES = iconTable.shapes as Record<string, IconShape | undefined>;
const BY_EXTENSION = iconTable.byExtension as Record<string, string | undefined>;
const BY_FILENAME = iconTable.byFilename as Record<string, string | undefined>;

/**
 * The generic outline drawn for a file no icon covers.
 *
 * Deliberately uncoloured: a grey page reads as "just a file", where a borrowed logo would assert
 * a language the file is not. Every other shape carries `fill` on its own paths, so `fill-current`
 * below reaches this one alone -- which is exactly the one that should take the row's muted tone.
 */
const UNKNOWN: IconShape = {
  viewBox: "0 0 16 16",
  body: '<path d="M3 1.5h6.2l3.8 3.8v9.2H3v-13Zm6 1.4v2.6h2.6L9 2.9Z"/>',
};

/**
 * Which icon a name draws.
 *
 * A whole filename beats an extension (`package.json` is the npm mark, not the generic JSON one)
 * and a longer extension beats a shorter one (`docker-compose.yml` before `yml`) -- the precedence
 * VS Code resolves icon themes with, so a file looks the way people expect it to.
 */
export function iconNameFor(name: string): string | null {
  const lower = name.toLowerCase();
  const named = BY_FILENAME[lower];
  if (named) return named;
  const segments = lower.split(".");
  for (let start = 1; start < segments.length; start += 1) {
    const icon = BY_EXTENSION[segments.slice(start).join(".")];
    if (icon) return icon;
  }
  return null;
}

export function shapeFor(name: string): IconShape {
  const icon = iconNameFor(name);
  return (icon ? SHAPES[icon] : null) ?? UNKNOWN;
}

export function FileIcon({ name }: { name: string }) {
  const shape = shapeFor(name);
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={shape.viewBox}
      className="size-4 shrink-0 fill-current text-muted-foreground"
      // A build-time constant from the generated table, never a filename or any other runtime
      // value, so this carries no injection surface.
      dangerouslySetInnerHTML={{ __html: shape.body }}
    />
  );
}
