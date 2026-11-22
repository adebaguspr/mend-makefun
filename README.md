# mend — entry

mend is the patch tool SPEC.md specifies: one CLI that applies
unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a
tree of text files, matching old lines at three tiers and writing
every change or none. `main.ts` is the CLI (in a trial it hands over
to the kit's `runner.ts`, kept as the kit has it).

SPDX-License-Identifier: MIT
