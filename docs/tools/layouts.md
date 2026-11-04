# Layout pool authoring

`gma3_layouts`, `gma3_store_layout` and `gma3_edit_layout_elements` inspect and author general Layout pool objects and their elements. They require an explicit `data_pool` number. This is separate from `gma3_layout_cells`, which edits fixture cell geometry in a fixture type.

The bounded initial surface supports decorative elements and Macro, Sequence and Group assignments, integer geometry, class-specific actions, appearance overrides, custom text and element visibility. It does not expose every Layout property or Layout Viewer window setting. It does not open or configure a Viewer, invoke an element, run an assigned macro/sequence, select fixtures or clear programmer values.

The implementation uses existing `objects`, `children`, `object`, `set` and `cmd` bridge operations with arbitrary Lua disabled. It never falls back to OSC or automatically retries an uncertain mutation. Mutations from this server are serialised across preflight, writes and read-back; this does not isolate them from another operator or client.

## Read layouts

`gma3_layouts` accepts:

| Parameter | Meaning |
| --- | --- |
| `data_pool` | Required data pool, 1–9999. |
| `layout` | Optional layout number, 1–9999. Omit to list the pool. |
| `offset`, `limit` | Zero-based page offset and 1–500 items (default 100). |
| `schema` | Include the layout's live property schema (default false). |

Pool reads use `children` on the scoped Layouts pool. A specific layout uses `objects` for its fields, then two bounded `children` reads per page: display fields contain the GUID, while `asText:false` returns the assigned Object as a typed handle. Length/address/index differences between those pages are refused. `schema:true` also uses `object`.

A missing layout returns `exists:false`. Element pages return `total`, `offset`, `count`, `incomplete`, and elements with `element` (current number), `guid`, `ref`, `class`, `name` and uppercase `fields`. Read every required page; a page is not a complete layout snapshot. GUIDs and numbers can be unavailable in a read result; editing refuses elements without readable unique identities.

Use the returned `{element, guid}` pair for an update/removal. Element numbers and numeric addresses can shift after deletion; the GUID identifies the surviving element. A stale pair is refused during preflight. Within one batch, later targets are followed by GUID when an earlier removal changes their numbers. Read fresh identities after each call.

## Create or update a layout

`gma3_store_layout` accepts `data_pool`, `layout` and required `mode: "create" | "update"`. Create refuses an occupied number. Update requires an existing layout and at least one supplied setting. A supplied name is checked against the Layout pool before mutation.

| Optional settings | Console properties |
| --- | --- |
| `name`, `note` | `Name`, `Note` |
| `canvas_x`, `canvas_y` | `PositionX`, `PositionY` |
| `canvas_width`, `canvas_height` | `DimensionW`, `DimensionH` |
| `view_position_active` | `ViewPosActive` |
| `view_x`, `view_y`, `view_scale` | `ViewPosX`, `ViewPosY`, `ViewPosScale` |
| `markers`, `value_colors` | `Markers`, `ValueColors` |
| `preview` | Read and validate the plan without mutations (default false). |

Canvas coordinates are signed Int16 layout units (−32768…32767); dimensions are 1…32767. View coordinates are signed Int32; `view_scale` is a positive unitless ratio bounded at 10000 (`0.8` means 80%). The console setter takes that ratio but its edit/read roles display percent, so verification compares the read-back to the supplied ratio × 100. Zero is a valid coordinate and false is a supplied boolean. Names and notes follow the existing shared validators; names are trimmed and reject console-stripped punctuation, notes are trimmed.

Commands/requests, in order:

1. Inspect the target, lock flags, name collisions and applicable live schema.
2. For create only: `Store DataPool <p> Layout <n> /NoConfirmation`, then inspect the created schema.
3. One `set` request per supplied field, stopping on the first rejected or uncertain write.
4. `objects` read-back of existence and supplied fields.

No element is removed or rebuilt. An update changes supplied fields only. Names and notes compare literally after shared input normalization. Read-back does not verify how a Viewer renders the layout. A new layout's schema is available only after creation; a later refusal can leave the new empty layout in place and is reported as partial completion.

## Edit elements

`gma3_edit_layout_elements` accepts `data_pool`, `layout`, `edits` (1–100 items) and optional `preview` (default false). The layout must already exist.

Each edit has one of these forms:

```json
{"operation":"add","x":-120,"y":80,"width":100,"height":50,"object":{"type":"Macro","number":970},"action":"Go+","custom_text":"Start"}
```

```json
{"operation":"update","identity":{"element":1,"guid":"<GUID from gma3_layouts>"},"x":0,"visibility":{"object_name":"Hidden"}}
```

```json
{"operation":"remove","identity":{"element":1,"guid":"<GUID from gma3_layouts>"}}
```

Add requires all four geometry fields. Update changes only supplied fields and requires a setting or assignment. Remove has no change fields. Duplicate identities in one batch are refused. The tool checks the Layout and element `Lock`, `StructureLocked` and `SystemLocked` flags and the live writable-property schema; unknown protection state is a refusal. It does not unlock objects automatically.

| Change parameter | Meaning / property |
| --- | --- |
| `object` | `{type:"Macro"|"Sequence"|"Group", number:1…9999}` in the explicit data pool; resolved to its numeric object address. |
| `replace_object` | Required true when replacing a different existing assignment. Default false. |
| `x`, `y`, `width`, `height` | `PosX`, `PosY`, `Width`, `Height`; same Int16 position and positive dimension bounds as above. |
| `action` | `Action`; validated against the actual assigned object class. |
| `appearance` | Global Appearance pool number, 1–9999. The override is resolved and verified by address. |
| `custom_text` | `CustomTextText`, at most 2048 characters, exact case/quotes/internal spaces; no control characters or leading/trailing whitespace. |
| `custom_text_color` | `CustomTextColor`, eight hexadecimal RGBA digits, e.g. `11AA33FF`. |
| `custom_text_size` | `CustomTextSize`: `"9"`, `"11"`, `"14"`, `"16"`, `"18"`, `"20"`, `"24"`, `"28"`, `"32"`. |
| `custom_text_align_h` | `CustomTextAlignmentH`: `Center`, `Left`, `Right`, `OutsideLeft`, `OutsideRight`. |
| `custom_text_align_v` | `CustomTextAlignmentV`: `Center`, `Top`, `Bottom`, `Above`, `Below`. |
| `custom_text_vertical` | `CustomTextVertical`, boolean. |
| `visibility` | Object with optional `element`, `object_name`, `id`, `cid`, `bar`, `value`, `icon`, `indicator_bar`, `border`; each `Visible` or `Hidden`. |

Macro actions: `<<<`, `>>>`, `Call`, `Go+`, `Go-`, `Off`, `Pause`. Group action: `SelectFixtures`. Sequence actions follow the existing sequence function vocabulary, including Go/Off/Toggle, Flash/Temp/Swap, navigation and speed/rate controls. Unsupported classes/actions are refused rather than relying on the generic Action property's permissive enum. Changing an action configures the future element interaction; it never invokes that action.

Custom text edge whitespace is refused because read-only bridge strings are trimmed, making independent final verification impossible. Exact case, quotes and internal spacing are verified. Assignment clearing, default-action/default-appearance inheritance controls, padding, borders, image rotation/mirroring, pool/canvas appearances and additional object classes are outside this initial write surface; their available fields can still be inspected generically.

Commands/requests, in order:

1. Inspect the Layout, full element membership/identities, requested object/appearance sources and writable schemas. Refuse invalid targets before mutation; preview stops here and returns `planned`.
2. Recheck Layout locks, membership and target identity before each item.
3. Add: `Store DataPool <p> Layout <n>.<next> /NoConfirmation`. Identify exactly one new GUID while preserving prior GUIDs, then inspect its writable schema.
4. Assignment, if supplied: `set Object` using the resolved numeric address, then `objects asText:false` to compare the actual assigned address. **Do not substitute `Assign Macro … At Layout n.k`: the qualified console appends an element instead of replacing k.**
5. Appearance, if supplied: `set Appearance` using the source numeric address, then resolve the returned `#<hex>` reference with `object` and compare its address.
6. Other changes: one `set` per supplied property, checking immediate read-back. Custom text comparisons are literal; numeric/boolean fields use their existing normalizers.
7. Remove: `Delete DataPool <p> Layout <n>.<current> /NoConfirmation`, then verify exactly the requested GUID disappeared.
8. Read the resulting elements and verify requested GUIDs, supplied fields, assigned object addresses and appearance identity. Report remaining current identities.

A failure or lost reply stops later mutations and reports unattempted items. Applied earlier changes and newly created elements remain inspectable; the tool does not silently roll back or rebuild. An uncertain creation without an identified GUID is never called verified. Read-back verifies stored configuration, not rendering or successful execution of an assigned macro/sequence.

## Qualification and tests

The source of truth for field names is the running console's schema. The live test passed (1/1) in a disposable show on grandMA3 onPC 2.5.1.1 for macOS with bridge 0.49.0 after checking enum names and write behavior. Cleanup of the reserved objects was verified; no assigned object was executed. This is a bounded qualification, not a claim of every setting or version/platform.

Run `node --import tsx --test test/layouts.test.ts` for the focused fake-bridge suite. It covers explicit scoping, name/number collisions, preview, exact text, locks/read-only schema, identity staleness and renumbering, assignment/action validation, appearance identity, mutation serialization, partial completion and unknown outcomes without replay.

`test/live/layouts.live.ts` is separately opt-in and refuses occupied DataPool 1 Layout 909, Macro 970, Sequence 970 and global Appearance 970. It requires a disposable show and confirmed empty programmer, creates/cleans up those objects, and does not call SaveShow or invoke assigned objects. The root operator runs it; automated unit tests do not establish live console behavior.
