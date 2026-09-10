// The mark on a file row.
//
// The IDE this replaces embedded a generated copy of the material-icon-theme: 1212 lines of SVG
// paths for one tree's decoration. The panel already has an icon vocabulary in `lucide-react`, and
// two icon systems in one panel is the duplication the conventions here exist to stop, so this is
// a small map onto that vocabulary instead.
//
// A whole filename beats an extension (`package.json` is a config, not generic JSON) and a longer
// extension beats a shorter one, which is the precedence VS Code resolves icon themes with.

import {
  Braces,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  FileType,
  Image,
  Settings,
  Sheet,
  Terminal,
  type LucideIcon,
} from "lucide-react";

const BY_FILENAME: Record<string, LucideIcon> = {
  "package.json": Settings,
  "tsconfig.json": Settings,
  "justfile": Terminal,
  "dockerfile": Settings,
  "makefile": Terminal,
  ".gitignore": Settings,
  "readme.md": FileText,
};

const BY_EXTENSION: Record<string, LucideIcon> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  swift: FileCode,
  rs: FileCode,
  py: FileCode,
  go: FileCode,
  rb: FileCode,
  sh: Terminal,
  zsh: Terminal,
  json: Braces,
  jsonc: Braces,
  yml: Settings,
  yaml: Settings,
  toml: Settings,
  ini: Settings,
  env: Settings,
  md: FileText,
  markdown: FileText,
  txt: FileText,
  html: FileCode,
  htm: FileCode,
  css: FileType,
  scss: FileType,
  svg: Image,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  ipynb: Sheet,
  docx: FileType,
  csv: Sheet,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
};

/**
 * Which icon a name draws.
 *
 * A plain document for anything unrecognised, deliberately: a borrowed logo asserts a language the
 * file is not, where a grey page reads as "just a file".
 */
export function iconForFilename(name: string): LucideIcon {
  const lower = name.toLowerCase();
  const named = BY_FILENAME[lower];
  if (named) return named;
  const segments = lower.split(".");
  for (let start = 1; start < segments.length; start += 1) {
    const icon = BY_EXTENSION[segments.slice(start).join(".")];
    if (icon) return icon;
  }
  return FileText;
}

export function FileIcon({ name }: { name: string }) {
  const Icon = iconForFilename(name);
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}
