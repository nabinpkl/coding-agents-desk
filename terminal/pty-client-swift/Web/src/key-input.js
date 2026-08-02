const plainCharacters = Object.freeze({
  'ansi-comma': [',', '<'],
  'ansi-period': ['.', '>'],
  'ansi-slash': ['/', '?'],
  'ansi-semicolon': [';', ':'],
  'ansi-quote': ["'", '"'],
  'ansi-leftbracket': ['[', '{'],
  'ansi-rightbracket': [']', '}'],
  'ansi-backslash': ['\\', '|'],
  'ansi-minus': ['-', '_'],
  'ansi-equal': ['=', '+'],
  'ansi-grave': ['`', '~'],
});

function modifierSet(modifiers) {
  return new Set(Array.isArray(modifiers) ? modifiers : []);
}

function characterForCode(code, modifiers) {
  const shifted = modifiers.has('shift');
  if (/^ansi-[A-Z]$/.test(code)) {
    const letter = code.slice(-1);
    return shifted ? letter : letter.toLowerCase();
  }
  if (/^ansi-[0-9]$/.test(code)) {
    const digit = code.slice(-1);
    if (!shifted) return digit;
    return ')!@#$%^&*('[Number(digit)];
  }
  const pair = plainCharacters[code];
  return pair?.[shifted ? 1 : 0] ?? null;
}

function controlCharacter(character) {
  if (character.length !== 1) return null;
  const code = character.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  if (character === ' ') return '\x00';
  if (character === '?') return '\x7f';
  return null;
}

function metaPrefix(modifiers) {
  return modifiers.has('option') || modifiers.has('command') ? '\x1b' : '';
}

function arrowSequence(code, modifiers, applicationCursorKeysMode) {
  const suffix = { up: 'A', down: 'B', right: 'C', left: 'D' }[code];
  if (!suffix) return null;
  const modifierParameter = 1
    + (modifiers.has('shift') ? 1 : 0)
    + (modifiers.has('option') ? 2 : 0)
    + (modifiers.has('control') ? 4 : 0)
    + (modifiers.has('command') ? 8 : 0);
  if (modifierParameter !== 1) return `\x1b[1;${modifierParameter}${suffix}`;
  return applicationCursorKeysMode ? `\x1bO${suffix}` : `\x1b[${suffix}`;
}

export function encodeTerminalKey(code, rawModifiers, applicationCursorKeysMode = false) {
  const modifiers = modifierSet(rawModifiers);
  const arrow = arrowSequence(code, modifiers, applicationCursorKeysMode);
  if (arrow) return arrow;

  if (code === 'escape') return '\x1b';
  if (code === 'tab') {
    const tab = modifiers.has('shift') ? '\x1b[Z' : '\t';
    return `${metaPrefix(modifiers)}${tab}`;
  }
  if (code === 'return') return `${metaPrefix(modifiers)}\r`;
  if (code === 'delete') {
    const deletion = modifiers.has('control') ? '\x08' : '\x7f';
    return `${metaPrefix(modifiers)}${deletion}`;
  }
  if (code === 'space') {
    const space = modifiers.has('control') ? '\x00' : ' ';
    return `${metaPrefix(modifiers)}${space}`;
  }

  const character = characterForCode(code, modifiers);
  if (character === null) return null;
  const value = modifiers.has('control')
    ? controlCharacter(character)
    : character;
  return value === null ? null : `${metaPrefix(modifiers)}${value}`;
}
