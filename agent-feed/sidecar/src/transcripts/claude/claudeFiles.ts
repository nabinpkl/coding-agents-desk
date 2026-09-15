// Which files a Claude tool call names, and in what order.
//
// One home because two readers have to agree on the ORDER, not just the set: the normalizer puts
// this list on the tool_use block, the panel asks for a picture by its POSITION in that list, and
// `GET .../blocks/<b>/files/<k>` resolves the position here again. A second copy of the rule
// anywhere would mean a request for the third file answered with the fifth.
//
// Claude only, like the route: it is the vocabulary of Claude's own tools.

/** A call that hands files over says so in a list. `SendUserFile` is the one that does. */
const FILE_LIST_KEY = 'files';

/** A call that works ON one file names it in one of these. */
const SINGLE_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** A call that runs a command has its files inside the command string. */
const COMMAND_KEYS = ['command', 'cmd'] as const;

const PICTURE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * An absolute path to a picture, inside a shell command.
 *
 * Only pictures and only absolute, because this is a guess about a string nobody wrote for us to
 * read, and those two conditions are what make the guess cheap to be wrong about: a path that
 * names nothing answers 404 and the row draws no picture. Stops at whitespace, a quote, a
 * backtick or a closing bracket, which is where a path ends in every shell this sees.
 */
const COMMAND_PICTURE = /(?:^|[\s'"=(`:,])(\/[^\s'"`),;]+\.(?:png|jpe?g|gif|webp))/gi;

/**
 * How many a single call contributes. A command can mention a directory's worth of renders, and
 * every one of them is a request the panel would make while the row is on screen.
 */
const MAX_FILES = 8;

/** Whether a name is one the panel would draw as a picture. */
export function isPictureName(path: string): boolean {
  return PICTURE_NAME.test(path);
}

/**
 * The files this call names, deduped and in a stable order: what it handed over first, then the
 * file it worked on, then the pictures its command mentions.
 *
 * Absolute paths only. A relative one is resolved against whatever directory a process happens to
 * be in, which is not the directory the transcript was talking about.
 */
export function toolFilePaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const found: string[] = [];
  const add = (value: unknown, pictureOnly: boolean) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (!path.startsWith('/') || found.includes(path)) return;
    if (pictureOnly && !isPictureName(path)) return;
    found.push(path);
  };

  const handed = input[FILE_LIST_KEY];
  // Everything a call handed over, picture or not: the reader was sent those files, and a report
  // they cannot see drawn is still a file they were sent.
  if (Array.isArray(handed)) for (const file of handed) add(file, false);
  for (const key of SINGLE_PATH_KEYS) add(input[key], true);
  for (const key of COMMAND_KEYS) {
    const command = input[key];
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(COMMAND_PICTURE)) add(match[1], true);
  }
  return found.slice(0, MAX_FILES);
}
