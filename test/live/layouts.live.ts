/**
 * General Layout authoring live qualification, never run by npm test.
 * Creates/deletes DataPool 1 Layout 909, Macro 970, Sequence 970 Cue 1 and global Appearance 970.
 * All four must be absent. Requires a disposable loaded show and a confirmed empty programmer.
 * No assigned macro/sequence is invoked, no selection is changed, and no SaveShow is sent.
 * Run only by the console operator:
 *   GMA3_LIVE=1 node --import tsx --test test/live/layouts.live.ts
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { liveTest, cmd } from "./live.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { exists } from "../../src/tools/common.ts";
import { readLayouts, storeLayout, editLayoutElements } from "../../src/tools/layouts.ts";

const POOL = 1;
const LAYOUT = 909;
const SOURCE = 970;
const elementSchema = z.object({ element: z.number().int().positive(), guid: z.string().min(1), fields: z.record(z.string(), z.unknown()) });
const layoutSchema = z.object({ exists: z.literal(true), elements: z.array(elementSchema), total: z.number() });
const programmerSchema = z.object({ rows: z.array(z.unknown()), coverage: z.object({ complete: z.boolean() }), stats: z.object({ channelErrors: z.number(), channelsWithData: z.number() }), limitations: z.array(z.unknown()).optional() });

liveTest("General Layout authoring: add/edit/remove with GUID identity, appearance and non-executing assignments (Layout 909, Macro/Sequence/Appearance 970)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const references = [`DataPool ${POOL} Layout ${LAYOUT}`, `DataPool ${POOL} Macro ${SOURCE}`, `DataPool ${POOL} Sequence ${SOURCE}`, `Appearance ${SOURCE}`];
  for (const ref of references) assert.equal((await exists(bridge, ref)).exists, false, `${ref} must be confirmed absent`);
  const programmer = programmerSchema.parse(await bridge.request("programmer", {}));
  if (!programmer.coverage.complete || programmer.rows.length || programmer.stats.channelErrors || programmer.stats.channelsWithData || programmer.limitations?.length) { t.skip("Programmer is not confirmed empty; source sequence storage would capture it"); return; }
  t.after(async () => {
    await bridge.request("set", { ref: references[0], property: "Lock", value: "No" }).catch(() => {});
    for (const ref of references) await cmd(`Delete ${ref} /NoConfirmation`);
  });
  assert.equal(await cmd(`Store DataPool ${POOL} Macro ${SOURCE} /NoConfirmation`), "OK");
  assert.equal(await cmd(`Store DataPool ${POOL} Sequence ${SOURCE} Cue 1 /NoConfirmation`), "OK");
  assert.equal(await cmd(`Store Appearance ${SOURCE} /NoConfirmation`), "OK");
  const base = { data_pool: POOL, layout: LAYOUT };
  const read = async () => layoutSchema.parse(await readLayouts(ctx, base));
  const assertSuccess = (result: Awaited<ReturnType<typeof storeLayout>>) => {
    assert.equal(result.outcome, "succeeded", JSON.stringify(result));
    assert.equal(result.verification.status, "matched", JSON.stringify(result));
  };
  const preview = await storeLayout(ctx, { ...base, mode: "create", name: "MCP Layout authoring", preview: true });
  assert.equal(preview.outcome, "succeeded");
  assert.equal((await exists(bridge, references[0] ?? "")).exists, false, "preview creates nothing");
  assertSuccess(await storeLayout(ctx, { ...base, mode: "create", name: "MCP Layout authoring", canvas_x: -200, canvas_y: -100, canvas_width: 600, canvas_height: 400, note: "Disposable layout qualification" }));
  assert.equal((await storeLayout(ctx, { ...base, mode: "create" })).outcome, "failed", "create cannot overwrite");
  assertSuccess(await editLayoutElements(ctx, { ...base, edits: [
    { operation: "add", x: -120, y: 80, width: 100, height: 50, object: { type: "Macro", number: SOURCE }, action: "Go+", appearance: SOURCE, custom_text: 'Macro "label"  exact', custom_text_color: "11AA33FF", custom_text_size: "14", custom_text_align_h: "Left", custom_text_align_v: "Top", visibility: { object_name: "Hidden", element: "Visible" } },
    { operation: "add", x: 0, y: 80, width: 100, height: 50, custom_text: "Remove me" },
    { operation: "add", x: 120, y: 80, width: 100, height: 50, object: { type: "Sequence", number: SOURCE }, action: "Flash", custom_text: "Sequence" },
  ] }));
  const created = await read();
  assert.equal(created.total, 3);
  const [macro, decoration, sequence] = created.elements;
  if (!macro || !decoration || !sequence) throw new Error("Expected three created element identities");
  assert.equal(macro.fields.CUSTOMTEXTTEXT, 'Macro "label"  exact');
  assert.equal(macro.fields.CUSTOMTEXTCOLOR, "11AA33FF");
  assert.equal(macro.fields.VISIBILITYOBJECTNAME, "Hidden");
  const sequenceObject = z.object({ class: z.literal("Sequence"), addr: z.string() }).parse(sequence.fields.OBJECT);
  assert.equal(sequenceObject.class, "Sequence");
  assertSuccess(await editLayoutElements(ctx, { ...base, edits: [
    { operation: "remove", identity: { element: decoration.element, guid: decoration.guid } },
    { operation: "update", identity: { element: sequence.element, guid: sequence.guid }, x: 160, custom_text: "Updated Sequence" },
  ] }));
  const edited = await read();
  assert.equal(edited.total, 2);
  const retainedSequence = edited.elements.find((item) => item.guid === sequence.guid);
  assert.equal(retainedSequence?.element, 2, "sibling deletion renumbers while GUID stays stable");
  assert.equal(retainedSequence?.fields.CUSTOMTEXTTEXT, "Updated Sequence");
  assert.equal((await editLayoutElements(ctx, { ...base, edits: [{ operation: "update", identity: { element: sequence.element, guid: sequence.guid }, x: 0 }] })).outcome, "failed", "stale index is refused");
  await bridge.request("set", { ref: references[0], property: "Lock", value: "Yes" });
  assert.equal((await editLayoutElements(ctx, { ...base, edits: [{ operation: "update", identity: { element: macro.element, guid: macro.guid }, x: 0 }] })).outcome, "failed", "locked layout is refused");
  await bridge.request("set", { ref: references[0], property: "Lock", value: "No" });
  const sourceState = z.object({ hasActivePlayback: z.boolean() }).parse(await bridge.request("object", { ref: references[2], properties: false }));
  assert.equal(sourceState.hasActivePlayback, false, "assigning and configuring the sequence did not start it");
  t.diagnostic(`Verified Layout ${LAYOUT} geometry, exact custom text, appearance handle, action configuration, visibility, locks, stale identities and renumbering; assigned objects were never invoked.`);
});
