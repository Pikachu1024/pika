import { describe, expect, it } from "bun:test";
import { MaskedInput } from "../src/masked-input.js";

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function plain(input: MaskedInput, width = 40): string {
  return input.render(width).join("\n").replace(ansiPattern, "");
}

describe("masked input", () => {
  it("renders one mask character per code point", () => {
    const input = new MaskedInput();
    input.setValue("secret");
    expect(plain(input)).toContain("******");
    expect(plain(input)).not.toContain("secret");

    input.focused = true;
    const focused = plain(input);
    expect(focused).toContain("******");
    expect(focused).not.toContain("secret");
  });

  it("edits around the cursor and submits the plaintext", () => {
    const input = new MaskedInput();
    let submitted: string | undefined;
    input.onSubmit = (value) => {
      submitted = value;
    };

    input.handleInput("ab");
    input.handleInput("\u001b[D");
    input.handleInput("X");
    expect(input.getValue()).toBe("aXb");
    input.handleInput("\u007f");
    expect(input.getValue()).toBe("ab");

    input.handleInput("\r");
    expect(submitted).toBe("ab");
    expect(plain(input)).not.toContain("ab");
  });

  it("keeps the content of a bracketed paste", () => {
    const input = new MaskedInput();
    input.handleInput("\x1b[200~pasted-key\n\x1b[201~");
    expect(input.getValue()).toBe("pasted-key");
    expect(plain(input)).toContain("*".repeat(10));
    expect(plain(input)).not.toContain("pasted-key");
  });

  it("supports multi-character paste and escape", () => {
    const input = new MaskedInput();
    let escaped = false;
    input.onEscape = () => {
      escaped = true;
    };

    input.handleInput("pasted-key");
    expect(input.getValue()).toBe("pasted-key");
    expect(plain(input)).toContain("*".repeat(10));

    input.handleInput("\u001b");
    expect(escaped).toBe(true);
  });
});
