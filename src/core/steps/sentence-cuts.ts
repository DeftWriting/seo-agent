const TERMINAL_PUNCTUATION = /[.!?…](?:["'’”)\]]*)$/u;
const CLOSING_PUNCTUATION = /["'’”)\]]/u;

export function isFullSentenceMatch(source: string, candidate: string): boolean {
  if (!candidate || candidate !== candidate.trim() || !TERMINAL_PUNCTUATION.test(candidate)) {
    return false;
  }
  const index = source.indexOf(candidate);
  if (index < 0 || index !== source.lastIndexOf(candidate)) return false;

  let before = index - 1;
  let crossedLineBreak = false;
  while (before >= 0 && /\s/u.test(source[before] ?? "")) {
    crossedLineBreak ||= source[before] === "\n" || source[before] === "\r";
    before -= 1;
  }
  if (before >= 0 && !crossedLineBreak) {
    while (before >= 0 && CLOSING_PUNCTUATION.test(source[before] ?? "")) before -= 1;
    if (before >= 0 && !/[.!?…]/u.test(source[before] ?? "")) return false;
  }

  const after = index + candidate.length;
  return after === source.length || /\s/u.test(source[after] ?? "");
}
