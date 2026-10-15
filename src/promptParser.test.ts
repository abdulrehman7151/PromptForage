import assert from "node:assert/strict";
import test from "node:test";
import { groupLinesIntoPrompts } from "./promptParser.js";

test("groups numbered prompts and preserves multiline text", () => {
    assert.deepEqual(
        groupLinesIntoPrompts([
            "Intro text that is not a prompt",
            "1. A quiet forest at sunrise",
            "with mist between the trees.",
            "Prompt 2: A glass greenhouse",
            "filled with tropical plants.",
            "3) A still life with oranges"
        ]),
        [
            "A quiet forest at sunrise with mist between the trees.",
            "A glass greenhouse filled with tropical plants.",
            "A still life with oranges"
        ]
    );
});

test("splits consecutively numbered prompts sharing one PDF text line", () => {
    assert.deepEqual(
        groupLinesIntoPrompts([
            "1. City at sunset.  2. Tiger in a snowy forest.  3. Astronaut on Mars."
        ]),
        [
            "City at sunset.",
            "Tiger in a snowy forest.",
            "Astronaut on Mars."
        ]
    );
});

test("ignores unnumbered text before the first prompt", () => {
    assert.deepEqual(
        groupLinesIntoPrompts(["Cover page", "Prompt 1: First prompt"]),
        ["First prompt"]
    );
});

test("returns no prompts for unnumbered documents", () => {
    assert.deepEqual(groupLinesIntoPrompts(["A paragraph without numbering"]), []);
});
