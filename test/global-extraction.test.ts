import { describe, expect, test } from "vitest";
import { parseStringArray } from "../src/global-extraction.js";

describe("parseStringArray (tolerant parse of the model's global-fact reply)", () => {
  test("parses a plain JSON array", () => {
    expect(parseStringArray('["The user runs on the NJIT cluster.", "Uses A100 GPUs."]')).toEqual([
      "The user runs on the NJIT cluster.",
      "Uses A100 GPUs."
    ]);
  });
  test("parses a fenced ```json block", () => {
    expect(parseStringArray('```json\n["fact one", "fact two"]\n```')).toEqual(["fact one", "fact two"]);
  });
  test("extracts the array even with surrounding prose", () => {
    expect(parseStringArray('Here are the global facts: ["env fact"] — done')).toEqual(["env fact"]);
  });
  test("returns [] for an empty array or junk", () => {
    expect(parseStringArray("[]")).toEqual([]);
    expect(parseStringArray("no json here")).toEqual([]);
  });
  test("drops non-strings, trims, and caps at 8", () => {
    const arr = JSON.stringify(["  a  ", 5, "b", null, "c", "d", "e", "f", "g", "h", "i"]);
    expect(parseStringArray(arr)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});
