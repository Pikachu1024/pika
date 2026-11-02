export interface ParsedCommand {
  name: string;
  args: string[];
}

/** Splits input into whitespace-separated tokens, honoring double-quoted arguments. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quoted && char === "\\" && input[index + 1] === '"') {
      current += '"';
      started = true;
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && isWhitespace(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new Error("unterminated quote");
  if (started) tokens.push(current);
  return tokens;
}

/** Parses slash input into a command name and arguments, or undefined for plain prompts. */
export function parseCommand(input: string): ParsedCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const tokens = tokenize(trimmed);
  const name = (tokens[0] ?? "").slice(1);
  if (name.length === 0) throw new Error("empty command");
  return { name, args: tokens.slice(1) };
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
