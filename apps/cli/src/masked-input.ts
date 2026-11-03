import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  Key,
  matchesKey,
  visibleWidth,
} from "@mariozechner/pi-tui";

const MASK = "*";
const PROMPT = "> ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Single-line input that renders one mask character per code point. */
export class MaskedInput implements Component, Focusable {
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  #chars: string[] = [];
  #cursor = 0;

  getValue(): string {
    return this.#chars.join("");
  }

  setValue(value: string): void {
    this.#chars = [...value];
    this.#cursor = this.#chars.length;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.onSubmit?.(this.getValue());
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onEscape?.();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.#cursor = Math.min(this.#chars.length, this.#cursor + 1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.#cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.#cursor = this.#chars.length;
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      if (this.#cursor > 0) {
        this.#chars.splice(this.#cursor - 1, 1);
        this.#cursor -= 1;
      }
      return;
    }
    if (matchesKey(data, Key.delete)) {
      this.#chars.splice(this.#cursor, 1);
      return;
    }
    // Terminal paste arrives wrapped in bracketed paste markers; keep the content only.
    const pasted = bracketedPaste(data);
    if (pasted !== undefined) {
      this.#insert(pasted);
      return;
    }
    // Ignore remaining escape sequences (arrows, function keys, lone escape markers).
    if (data.includes("\x1b")) return;
    this.#insert(data);
  }

  #insert(raw: string): void {
    const text = [...raw].filter((char) => char >= " " && char !== "\x7f").join("");
    if (text === "") return;
    this.#chars.splice(this.#cursor, 0, ...text);
    this.#cursor += [...text].length;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = width - PROMPT.length;
    if (available <= 0) return [PROMPT];
    const total = this.#chars.length;
    const visible = Math.min(total + 1, available);
    const start = Math.max(
      0,
      Math.min(this.#cursor - Math.floor(visible / 2), total - visible + 1),
    );
    const before = Math.min(Math.max(this.#cursor - start, 0), visible - 1);
    const atEnd = this.#cursor >= total;
    const after = Math.max(0, visible - before - 1);
    const cursorChar = atEnd ? " " : MASK;
    const cursor = this.focused ? `\x1b[7m${cursorChar}\x1b[27m` : cursorChar;
    const line = `${PROMPT}${MASK.repeat(before)}${this.focused ? CURSOR_MARKER : ""}${cursor}${MASK.repeat(after)}`;
    const padding = " ".repeat(Math.max(0, available - visibleWidth(line) + PROMPT.length));
    return [`${line}${padding}`];
  }
}

/** Returns the content of a bracketed paste, or undefined when the input is not a paste. */
function bracketedPaste(data: string): string | undefined {
  const start = data.indexOf(PASTE_START);
  if (start === -1) return undefined;
  const from = start + PASTE_START.length;
  const end = data.indexOf(PASTE_END, from);
  return data.slice(from, end === -1 ? data.length : end);
}
