// What agents and commands print is not always what the server takes: it refuses a NUL
// character, a broken surrogate pair, a summary over lines and text over its limits.

/** `text` without NUL characters and broken surrogate pairs. */
export function clean(text: string): string {
  return text.toWellFormed().replaceAll("\0", "");
}

/** `text` cleaned and cut to `max` characters, with an ellipsis when it was cut. */
export function cut(text: string, max: number): string {
  const cleaned = clean(text);
  if (cleaned.length <= max) {
    return cleaned;
  }
  // Not through the middle of a surrogate pair.
  return `${cleaned
    .slice(0, max - 1)
    .toWellFormed()
    .replace(/�$/, "")}…`;
}

/** `text` as one line: its line breaks and the space around them become single spaces. */
export function oneLine(text: string): string {
  return clean(text)
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}
