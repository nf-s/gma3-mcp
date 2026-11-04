# Local authoring qualification — macOS, onPC 2.5.1.1

Checked 29 October 2026 against bridge 0.49.0. All mutations ran in a saved disposable copy of the operator's show. The original show file's SHA-256 was recorded before testing and checked afterwards. New test objects were confirmed absent before creation and removed afterwards. No bridge plugin changes or new dependencies were needed.

## Qualified paths

| Surface | Evidence |
| --- | --- |
| Documentation | Real local API retrieval and stdio MCP search/get/reference/help; scoped Lua identities, manual authority, exact command text, bounded complete-source pagination. Blank browsing and edition-projected provenance have regression tests. |
| Layout authoring | `test/live/layouts.live.ts`, 1/1 passed: create, canvas fields, Macro/Sequence/decorative elements, actions, appearance identity, exact text/color/alignment, visibility, GUID-preserving deletion/renumbering, stale-identity and lock refusal. Separate stdio MCP smoke test qualified Group assignment with SelectFixtures configured but not invoked. |
| Executor authoring | `test/live/executor-authoring.live.ts`, 1/1 passed: Sequence/Macro assignment by address, macro Call configuration, continuous/discrete MA encoder modes, stored custom command, 2×2 dimensions, occupied-cell/proxy refusal, existing configuration load and planned recast. |
| Configurations | Separate stdio MCP smoke verified load preview/load, complete all-pool reference planning and exact-list recast. Recast reset the configured key function while preserving the assigned sequence and 2×2 size. |

All new paths worked with arbitrary Lua disabled. The test setup briefly enabled Lua only for a fixed read-only enumeration query and restored the previous disabled state. No assigned macro, sequence or layout element was invoked; no playback or executor press was sent. The programmer was confirmed empty before temporary sequence stores.

## Console behavior that informed the implementation

- `Store Layout N.K` creates a blank element. `Assign Macro M At Layout N.K` appended a different element in the probe; it is not used to replace a numbered element. The tools set Object to the resolved numeric address and verify the typed assigned handle independently.
- GUID is available through display/edit-role field reads, but was omitted through the default role. Layout reads combine validated display and typed-handle pages. Empty field maps can arrive as `[]`; only that exact empty form is normalized to an object.
- Setting an element's Appearance to its resolved numeric address stores an encoded handle. Existing object lookup resolves that encoded token; verification compares the resulting address, not a label.
- ViewPosScale accepts a ratio but displays a percentage: input 0.8 reads 80. The API documents ratio units and verifies the conversion.
- Executor Width extends right; Height extends toward higher executor row numbers. Child index is not executor No. Expanded cells can appear as Proxy objects and must not be treated as free.
- Continuous Encoder/MAEncoder functions and discrete left/right functions are mutually exclusive. Non-empty discrete assignments clear the continuous function; selecting a continuous function clears the discrete functions and their custom-enable flags. Empty assignments do not switch modes.
- Writing custom command text enables its custom flag automatically, and encoder command text also selects discrete mode. The tool requires an explicit enabled value with text. Unsupported inactive encoder-text writes into an active continuous mode are refused before mutation. A key's ordinary function can remain a masked fallback while its custom flag is enabled; this is reported.
- The default property role can append the executor address to a custom command when Add Executor is enabled. Stored text is read through the edit role for literal verification.
- `Store Page P.E At Configuration C` returned OK without storing a configuration. Complete profile saving is not exposed. Load/recast verify configuration identity, assigned-object preservation and dimensions; returned function observations do not verify the unavailable full saved profile.

## Limits

This qualifies the listed software/platform and tested fields, not every executor class or Layout Viewer setting. Sequence and Macro executors are supported; general Layout elements support Macro, Sequence, Group and decorative elements. Viewer window construction, full configuration saving and other documented MVP omissions remain outside these tools. The mutation lock serializes this server; it does not isolate other operators or clients. Unknown writes are never replayed.
