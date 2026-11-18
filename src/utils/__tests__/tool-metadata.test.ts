import { describe, it, expect } from "vitest";
import { buildSourceDescriptionPrefix } from "../tool-metadata.js";

describe("buildSourceDescriptionPrefix", () => {
  it.each([
    // Nothing to prepend
    [undefined, ""],
    ["", ""],
    ["   ", ""],
    ["\t\n", ""],
    // No sentence-ending punctuation: ". " is appended
    ["Prod DB", "Prod DB. "],
    /*
     * Sentence terminators get only a trailing space, never an extra '.':
     * - '.' guards against the classic "Prod DB.. Execute SQL..." double-period bug.
     * - ':' naturally introduces what follows (the tool template), so adding '.'
     *   would produce the artifact "Details below:. Execute...".
     */
    ["Prod DB.", "Prod DB. "],
    ["Production DB!", "Production DB! "],
    ["Query me?", "Query me? "],
    ["Details below:", "Details below: "],
    // Surrounding whitespace is trimmed before assessing punctuation
    ["  Prod DB  ", "Prod DB. "],
    ["  Prod DB.  ", "Prod DB. "],
    // Internal formatting (newlines, multiple words, mid-sentence punctuation)
    // is the user's intent and must not be altered.
    ["Line 1\nLine 2", "Line 1\nLine 2. "],
    ["Line A, Line B", "Line A, Line B. "],
    // ')' and ';' are mid-sentence / structural punctuation, not terminators:
    // ". " is still appended to produce a complete sentence boundary.
    ["(read-only)", "(read-only). "],
    ["Clause 1; clause 2", "Clause 1; clause 2. "],
  ])("turns %j into %j", (description, expected) => {
    expect(buildSourceDescriptionPrefix(description)).toBe(expected);
  });
});
