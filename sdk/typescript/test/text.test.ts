import { describe, expect, it } from "vitest";
import { clean, cut, oneLine } from "../src/text.ts";

describe("clean", () => {
  it("drops NUL characters and repairs broken surrogate pairs", () => {
    expect(clean("a\u0000b")).toBe("ab");
    expect(clean("a\ud800b").isWellFormed()).toBe(true);
    expect(clean("grüß 🙂")).toBe("grüß 🙂");
  });
});

describe("cut", () => {
  it("leaves text within the limit alone", () => {
    expect(cut("hello", 5)).toBe("hello");
  });

  it("cuts longer text to the limit, ending in an ellipsis", () => {
    expect(cut("hello world", 6)).toBe("hello…");
    expect(cut("hello world", 6)).toHaveLength(6);
  });

  it("doesn't cut through a surrogate pair", () => {
    const text = cut("ab🙂cd", 4);

    expect(text.isWellFormed()).toBe(true);
    expect(text).toBe("ab…");
  });
});

describe("oneLine", () => {
  it("joins lines with single spaces", () => {
    expect(oneLine("  first \r\n\n  second\nthird ")).toBe("first second third");
  });
});
