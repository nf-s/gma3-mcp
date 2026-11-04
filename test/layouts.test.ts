import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerLayoutTools } from "../src/tools/layouts.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

interface FakeLayout { name: string; fields: Record<string, unknown>; elements: Array<Record<string, unknown>> }
class LayoutConsole {
  layouts = new Map<number, FakeLayout>();
  ignored = new Set<string>();
  readOnly = new Set<string>();
  failReads = false;
  sources = new Map<string, { name: string; class: string; addr: string }>([["Macro 970", { name: "Macro 970", class: "Macro", addr: "100.2.970" }], ["Macro 971", { name: "Macro 971", class: "Macro", addr: "100.2.971" }], ["Sequence 970", { name: "Sequence 970", class: "Sequence", addr: "100.3.970" }], ["Appearance 970", { name: "Appearance 970", class: "Appearance", addr: "100.4.970" }]]);
  nextGuid = 1;
  element(layout: FakeLayout): Record<string, unknown> {
    const fields: Record<string, unknown> = { NO: layout.elements.length + 1, GUID: `element-${this.nextGuid++}`, LOCK: "", STRUCTURELOCKED: "No", SYSTEMLOCKED: "No", POSX: 0, POSY: 0, WIDTH: 50, HEIGHT: 50, OBJECT: { invalid: true }, ACTION: "None", APPEARANCE: "<Default>", CUSTOMTEXTTEXT: "", CUSTOMTEXTCOLOR: "FFFFFFFF", CUSTOMTEXTSIZE: "14", CUSTOMTEXTALIGNMENTH: "Center", CUSTOMTEXTALIGNMENTV: "Center", CUSTOMTEXTVERTICAL: "No", VISIBILITYELEMENT: "Visible", VISIBILITYOBJECTNAME: "Visible", VISIBILITYID: "Visible", VISIBILITYCID: "Visible", VISIBILITYBAR: "Visible", VISIBILITYVALUE: "Visible", VISIBILITYICON: "Visible", VISIBILITYINDICATORBAR: "Visible", VISIBILITYBORDER: "Visible" };
    layout.elements.push(fields);
    return fields;
  }
  layout(n: number, name = `Layout ${n}`): FakeLayout {
    const layout = { name, fields: { NO: n, NAME: name, NOTE: "", GUID: `layout-${n}`, LOCK: "", STRUCTURELOCKED: "No", SYSTEMLOCKED: "No", POSITIONX: 0, POSITIONY: 0, DIMENSIONW: 100, DIMENSIONH: 100, VIEWPOSSCALE: 100 }, elements: [] };
    this.layouts.set(n, layout);
    return layout;
  }
  install(h: Harness) {
    const find = (raw: unknown) => {
      const match = String(raw).match(/^DataPool 1 Layout (\d+)(?:\.(\d+))?$/);
      if (!match) return undefined;
      const layout = this.layouts.get(Number(match[1]));
      return layout ? { layout, no: Number(match[1]), element: match[2] === undefined ? undefined : Number(match[2]) } : undefined;
    };
    const summary = (no: number, layout: FakeLayout) => ({ class: "Layout", name: layout.name, addr: `100.1.${no}`, index: no, childCount: layout.elements.length, fields: { ...layout.fields, No: no, Name: layout.name } });
    h.fake.on("objects", (args) => {
      if (this.failReads) throw new Error("read unavailable");
      const source = this.sources.get(String(args.ref).replace(/^DataPool 1 /, ""));
      if (source) return { total: 1, items: [source] };
      const found = find(args.ref);
      const fields = found?.element === undefined ? undefined : found.layout.elements[found.element - 1];
      const item = found ? fields ? { class: "Element", index: found.element, addr: `100.1.${found.no}.${found.element}`, fields } : found.element === undefined ? summary(found.no, found.layout) : undefined : undefined;
      return { total: item ? 1 : 0, offset: 0, items: item ? [item] : [] };
    });
    h.fake.on("children", (args) => {
      if (this.failReads) throw new Error("read unavailable");
      if (args.ref === "DataPool 1") return { total: 1, items: [{ name: "Layouts", addr: "100.1" }] };
      if (args.ref === "100.1") return { total: this.layouts.size, items: [...this.layouts].map(([no, layout]) => summary(no, layout)) };
      const found = find(args.ref);
      if (!found) throw new Error("no object found");
      const offset = Number(args.offset ?? 0);
      return { total: found.layout.elements.length, offset, items: found.layout.elements.slice(offset, offset + Number(args.limit ?? 100)).map((fields, i) => ({ class: "Element", index: offset + i + 1, addr: `100.1.${found.no}.${offset + i + 1}`, fields: args.asText === false && Array.isArray(args.fields) && args.fields.length === 1 && args.fields[0] === "Object" ? fields.OBJECT && typeof fields.OBJECT === "object" && "invalid" in fields.OBJECT ? [] : { Object: fields.OBJECT } : fields })) };
    });
    h.fake.on("object", (args) => {
      if (args.ref === "#123") return this.sources.get("Appearance 970");
      const found = find(args.ref);
      if (!found) throw new Error("no object found");
      const fields = found.element === undefined ? found.layout.fields : found.layout.elements[found.element - 1];
      if (!fields) throw new Error("no object found");
      return { ...summary(found.no, found.layout), class: found.element === undefined ? "Layout" : "Element", properties: fields, schema: Object.keys(fields).map((name) => ({ name, readOnly: this.readOnly.has(name), type: "String" })) };
    });
    h.fake.on("set", (args) => {
      const found = find(args.ref);
      if (!found) throw new Error("no object found");
      const property = String(args.property).toUpperCase();
      const fields = found.element === undefined ? found.layout.fields : found.layout.elements[found.element - 1];
      if (!fields) throw new Error("no object found");
      if (!this.ignored.has(property)) {
        if (property === "OBJECT") fields[property] = [...this.sources.values()].find((entry) => entry.addr === args.value) ?? { invalid: true };
        else if (property === "APPEARANCE") fields[property] = "#123";
        else if (property === "VIEWPOSSCALE") fields[property] = String(Number(args.value) * 100);
        else fields[property] = args.value;
      }
      if (property === "NAME") found.layout.name = String(fields.NAME);
      return { value: property === "OBJECT" ? "assigned" : fields[property], readOk: true };
    });
    h.fake.onCommand((command) => {
      const store = command.match(/^Store DataPool 1 Layout (\d+)(?:\.(\d+))? \/NoConfirmation$/);
      if (store) {
        if (store[2]) {
          const layout = this.layouts.get(Number(store[1]));
          if (!layout) return "Illegal object";
          this.element(layout);
        } else this.layout(Number(store[1]));
        return "OK";
      }
      const remove = command.match(/^Delete DataPool 1 Layout (\d+)\.(\d+) \/NoConfirmation$/);
      const layout = remove ? this.layouts.get(Number(remove[1])) : undefined;
      if (!remove || !layout) return "Illegal command";
      layout.elements.splice(Number(remove[2]) - 1, 1);
      layout.elements.forEach((entry, index) => { entry.NO = index + 1; });
      return "OK";
    });
  }
}
const resultSchema = z.object({ outcome: z.string(), verification: z.object({ status: z.string() }), steps: z.array(z.object({ name: z.string(), status: z.string(), kind: z.string().optional() })), preview: z.boolean().optional() }).passthrough();
let h: Harness;
let console: LayoutConsole;
before(async () => { h = await startHarness(registerLayoutTools, { requestTimeoutMs: 70 }); });
after(async () => { await h.close(); });
beforeEach(() => { h.fake.reset(); console = new LayoutConsole(); console.install(h); });
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await h.callJson<unknown>(name, args);
  return { ...response, result: resultSchema.parse(response.result) };
};

test("layouts requires explicit data pool and validates bounds before bridge traffic", async () => {
  for (const args of [{ layout: 1 }, { data_pool: 0 }, { data_pool: 1, limit: 501 }]) assert.equal((await h.call("gma3_layouts", args)).isError, true);
  assert.equal(h.fake.requests.length, 0);
});
test("layouts returns bounded element pages with GUID identities and typed object handles", async () => {
  const layout = console.layout(1);
  layout.elements = [{ NO: 1, GUID: "one", OBJECT: { name: "Macro", class: "Macro", addr: "100.2.1" }, POSX: 0 }, { NO: 2, GUID: "two", POSX: -50 }];
  const response = await h.callJson<unknown>("gma3_layouts", { data_pool: 1, layout: 1, limit: 1, schema: true });
  const read = z.object({ incomplete: z.boolean(), total: z.number(), elements: z.array(z.object({ element: z.number(), guid: z.string(), fields: z.record(z.string(), z.unknown()) })), schema: z.array(z.unknown()) }).parse(response.result);
  assert.equal(read.incomplete, true);
  assert.equal(read.total, 2);
  assert.equal(read.elements[0]?.guid, "one");
  assert.deepEqual(read.elements[0]?.fields.OBJECT, { name: "Macro", class: "Macro", addr: "100.2.1" });
  assert.equal(h.fake.requests.some((request) => ["set", "cmd", "lua"].includes(request.op)), false);
});
test("layout pool reads stay within the explicit data pool", async () => {
  console.layout(1);
  const response = await h.callJson<unknown>("gma3_layouts", { data_pool: 1 });
  assert.equal(z.object({ total: z.number() }).parse(response.result).total, 1);
  assert.equal(h.fake.requests[0]?.args.ref, "DataPool 1");
});
test("create refuses occupied number and name collision without mutation", async () => {
  console.layout(1, "Taken");
  for (const args of [{ layout: 1 }, { layout: 2, name: "Taken" }]) {
    const response = await call("gma3_store_layout", { data_pool: 1, mode: "create", ...args });
    assert.equal(response.result.outcome, "failed");
  }
  assert.equal(h.fake.commands.length, 0);
  assert.equal(h.fake.requests.some((request) => request.op === "set"), false);
});
test("preview validates and returns a concrete plan without mutations", async () => {
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 2, mode: "create", name: "Controls", canvas_x: 0, preview: true });
  assert.equal(response.result.outcome, "succeeded");
  assert.equal(response.result.preview, true);
  assert.equal(h.fake.requests.some((request) => ["set", "cmd"].includes(request.op)), false);
});
test("create stores only the requested layout and verifies supplied fields", async () => {
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 2, mode: "create", name: "Controls", canvas_x: -50, canvas_y: 0, note: 'Quotes " remain' });
  assert.equal(response.isError, false, response.text);
  assert.equal(response.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["Store DataPool 1 Layout 2 /NoConfirmation"]);
  assert.equal(console.layouts.get(2)?.fields.POSITIONY, "0");
  assert.equal(console.layouts.get(2)?.fields.NOTE, 'Quotes " remain');
});
test("update changes only supplied fields and preserves elements", async () => {
  const layout = console.layout(1);
  layout.elements = [{ NO: 1, GUID: "keep" }];
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", canvas_x: 0 });
  assert.equal(response.result.verification.status, "matched");
  assert.equal(layout.elements.length, 1);
  assert.deepEqual(h.fake.requests.filter((request) => request.op === "set").map((request) => request.args.property), ["PositionX"]);
});
test("lock, unknown lock, read-only schema and missing target refuse update", async () => {
  const layout = console.layout(1);
  layout.fields.LOCK = "UL";
  assert.equal((await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", canvas_x: 0 })).result.outcome, "failed");
  delete layout.fields.LOCK;
  assert.equal((await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", canvas_x: 0 })).result.outcome, "failed");
  layout.fields.LOCK = "";
  console.readOnly.add("POSITIONX");
  assert.equal((await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", canvas_x: 0 })).result.outcome, "failed");
  assert.equal((await call("gma3_store_layout", { data_pool: 1, layout: 9, mode: "update", canvas_x: 0 })).result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => request.op === "set"), false);
});
test("silent console rejection stops subsequent writes and reports partial completion", async () => {
  console.layout(1);
  console.ignored.add("POSITIONX");
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", name: "Changed", canvas_x: 5, canvas_y: 10 });
  assert.equal(response.result.outcome, "partial");
  assert.equal(response.result.verification.status, "mismatched");
  assert.ok(response.result.steps.some((step) => step.name === "set_PositionY" && step.status === "skipped"));
});
test("lost mutation reply stops and never replays", async () => {
  console.layout(1);
  h.fake.on("set", () => SILENT);
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", canvas_x: 5, canvas_y: 10 });
  assert.equal(response.result.outcome, "unknown");
  assert.equal(h.fake.requests.filter((request) => request.op === "set").length, 1);
  assert.equal(h.fake.commands.length, 0);
});
test("read failures are failed preflight and invalid integer geometry is rejected", async () => {
  console.failReads = true;
  assert.equal((await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "create" })).result.outcome, "failed");
  const count = h.fake.requests.length;
  for (const patch of [{ canvas_x: 1.5 }, { canvas_x: -32769 }, { canvas_width: 0 }, { canvas_height: 32768 }]) assert.equal((await h.call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "create", ...patch })).isError, true);
  assert.equal(h.fake.requests.length, count);
});

const add = (patch: Record<string, unknown> = {}) => ({ operation: "add", x: 0, y: -20, width: 100, height: 50, ...patch });
const edit = (edits: unknown[], patch: Record<string, unknown> = {}) => call("gma3_edit_layout_elements", { data_pool: 1, layout: 1, edits, ...patch });
const identity = (fields: Record<string, unknown>) => ({ element: Number(fields.NO), guid: String(fields.GUID) });

test("adds decorative, macro and sequence elements without executing their assignments", async () => {
  const layout = console.layout(1);
  const response = await edit([add({ custom_text: "Section" }), add({ object: { type: "Macro", number: 970 }, action: "Go+", custom_text: 'Exact "text"  Case', custom_text_color: "11aa33ff", custom_text_size: "14", custom_text_align_h: "Left", custom_text_align_v: "Top", visibility: { object_name: "Hidden" } }), add({ object: { type: "Sequence", number: 970 }, action: "Flash" })]);
  assert.equal(response.isError, false, response.text);
  assert.equal(response.result.verification.status, "matched");
  assert.equal(layout.elements.length, 3);
  assert.equal(layout.elements[1]?.CUSTOMTEXTTEXT, 'Exact "text"  Case');
  assert.equal(layout.elements[1]?.CUSTOMTEXTCOLOR, "11AA33FF");
  assert.deepEqual(h.fake.commands, ["Store DataPool 1 Layout 1.1 /NoConfirmation", "Store DataPool 1 Layout 1.2 /NoConfirmation", "Store DataPool 1 Layout 1.3 /NoConfirmation"]);
  assert.equal(h.fake.requests.some((request) => request.op === "lua"), false);
});
test("appearance overrides resolve encoded handles and verify the appearance address", async () => {
  const layout = console.layout(1);
  const response = await edit([add({ appearance: 970 })]);
  assert.equal(response.isError, false, response.text);
  assert.equal(response.result.verification.status, "matched");
  assert.equal(layout.elements[0]?.APPEARANCE, "#123");
  assert.ok(h.fake.requests.some((request) => request.op === "object" && request.args.ref === "#123"));
});
test("stale and duplicate element identities refuse the entire batch before mutation", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  for (const edits of [[{ operation: "update", identity: { element: 1, guid: "stale" }, x: 5 }], [{ operation: "update", identity: identity(existing), x: 5 }, { operation: "remove", identity: identity(existing) }]]) {
    const response = await edit(edits);
    assert.equal(response.result.outcome, "failed");
  }
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});
test("removing a sibling preserves GUID addressing for a later update and retains other elements", async () => {
  const layout = console.layout(1);
  const first = console.element(layout);
  const second = console.element(layout);
  const third = console.element(layout);
  const response = await edit([{ operation: "remove", identity: identity(first) }, { operation: "update", identity: identity(third), x: 25 }]);
  assert.equal(response.isError, false, response.text);
  assert.equal(layout.elements.length, 2);
  assert.equal(layout.elements[0]?.GUID, second.GUID);
  assert.equal(layout.elements[1]?.GUID, third.GUID);
  assert.equal(layout.elements[1]?.POSX, "25");
  assert.ok(h.fake.requests.some((request) => request.op === "set" && request.args.ref === "DataPool 1 Layout 1.2"));
});
test("existing assignment replacement requires explicit replace_object", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  existing.OBJECT = console.sources.get("Macro 970");
  const changes = { operation: "update", identity: identity(existing), object: { type: "Macro", number: 971 } };
  assert.equal((await edit([changes])).result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => request.op === "set"), false);
  const response = await edit([{ ...changes, replace_object: true }]);
  assert.equal(response.isError, false, response.text);
  assert.deepEqual(existing.OBJECT, console.sources.get("Macro 971"));
});
test("actions are validated against the actual assigned class, including retained assignments", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  existing.OBJECT = console.sources.get("Macro 970");
  for (const edits of [[add({ object: { type: "Macro", number: 970 }, action: "Flash" })], [{ operation: "update", identity: identity(existing), action: "SelectFixtures" }], [add({ action: "Go+" })]]) assert.equal((await edit(edits)).result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});
test("element preview resolves targets and produces no mutation", async () => {
  console.layout(1);
  const response = await edit([add({ object: { type: "Macro", number: 970 }, action: "Go+" })], { preview: true });
  assert.equal(response.result.preview, true);
  assert.equal(response.result.outcome, "succeeded");
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});
test("locked elements and read-only element fields refuse updates", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  existing.LOCK = "UL";
  assert.equal((await edit([{ operation: "remove", identity: identity(existing) }])).result.outcome, "failed");
  existing.LOCK = "";
  console.readOnly.add("POSX");
  assert.equal((await edit([{ operation: "update", identity: identity(existing), x: 2 }])).result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});
test("lost create reply is unknown, never replayed or verified by an empty expectation list", async () => {
  console.layout(1);
  h.fake.onCommand(() => SILENT);
  const response = await edit([add(), add()]);
  assert.equal(response.result.outcome, "unknown");
  assert.equal(response.result.verification.status, "unavailable");
  assert.equal(h.fake.commands.length, 1);
  assert.equal(h.fake.requests.some((request) => request.op === "set"), false);
  assert.ok(response.result.steps.some((step) => step.name === "edit_2" && step.status === "skipped"));
});
test("literal custom text case and internal spaces must match exactly", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  existing.CUSTOMTEXTTEXT = "two words";
  console.ignored.add("CUSTOMTEXTTEXT");
  for (const custom_text of ["Two words", "two  words"]) {
    const response = await edit([{ operation: "update", identity: identity(existing), custom_text }]);
    assert.equal(response.result.outcome, "failed");
    assert.equal(response.result.verification.status, "mismatched");
  }
});
test("unverifiable edge whitespace and unsupported text/geometry values are rejected before traffic", async () => {
  console.layout(1);
  for (const patch of [{ custom_text: " leading" }, { custom_text: "trailing " }, { custom_text_size: "12" }, { custom_text_color: "red" }, { visibility: { element: "Yes" } }, { width: 0 }, { x: 0.5 }]) assert.equal((await h.call("gma3_edit_layout_elements", { data_pool: 1, layout: 1, edits: [add(patch)] })).isError, true);
  assert.equal(h.fake.requests.length, 0);
});
test("mutations in concurrent layout calls are serialised through their read-back", async () => {
  console.layout(1);
  const response = await Promise.all([edit([add({ x: 1 })]), edit([add({ x: 2 })])]);
  assert.ok(response.every((item) => !item.isError), response.map((item) => item.text).join("\n"));
  assert.deepEqual(h.fake.commands, ["Store DataPool 1 Layout 1.1 /NoConfirmation", "Store DataPool 1 Layout 1.2 /NoConfirmation"]);
});


test("view scale writes a ratio and verifies the console percentage display", async () => {
  const layout = console.layout(1);
  const response = await call("gma3_store_layout", { data_pool: 1, layout: 1, mode: "update", view_scale: 0.8 });
  assert.equal(response.isError, false, response.text);
  assert.equal(response.result.verification.status, "matched");
  assert.equal(layout.fields.VIEWPOSSCALE, "80");
  assert.equal(h.fake.requests.find((request) => request.op === "set")?.args.value, "0.8");
});

test("an unreadable typed assignment is not treated as empty for replacement", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  existing.OBJECT = "untyped assignment";
  const response = await edit([{ operation: "update", identity: identity(existing), object: { type: "Macro", number: 970 } }]);
  assert.equal(response.result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});

test("membership changes between pages refuse a broad edit without mutation", async () => {
  const layout = console.layout(1);
  for (let index = 0; index < 501; index++) console.element(layout);
  const handler = h.fake.handlerFor("children");
  if (!handler) throw new Error("missing fake children handler");
  h.fake.on("children", (args, request) => {
    if (Number(args.offset) === 500) return { total: 500, items: [] };
    return handler(args, request);
  });
  const response = await edit([add()]);
  assert.equal(response.result.outcome, "failed");
  assert.equal(h.fake.requests.some((request) => ["cmd", "set"].includes(request.op)), false);
});

test("blank decorative elements accept the bridge's empty-array Object field map", async () => {
  const layout = console.layout(1);
  console.element(layout);
  const response = await h.callJson<unknown>("gma3_layouts", { data_pool: 1, layout: 1 });
  const read = z.object({ elements: z.array(z.object({ guid: z.string(), fields: z.record(z.string(), z.unknown()) })) }).parse(response.result);
  assert.equal(read.elements[0]?.guid, "element-1");
  assert.equal(read.elements[0]?.fields.OBJECT, undefined);
});
test("nonempty array field maps are rejected at the bridge boundary", async () => {
  console.layout(1);
  h.fake.on("children", () => ({ total: 1, items: [{ class: "Element", fields: ["malformed"] }] }));
  await assert.rejects(h.call("gma3_layouts", { data_pool: 1, layout: 1 }), /expected record, received array/);
});

test("final read-back detects a literal case change after an accepted immediate reply", async () => {
  const layout = console.layout(1);
  const existing = console.element(layout);
  const handler = h.fake.handlerFor("set");
  if (!handler) throw new Error("missing fake set handler");
  h.fake.on("set", async (args, request) => {
    const reply = await handler(args, request);
    if (args.property === "CustomTextText") existing.CUSTOMTEXTTEXT = String(existing.CUSTOMTEXTTEXT).toLowerCase();
    return reply;
  });
  const response = await edit([{ operation: "update", identity: identity(existing), custom_text: "Exact Case" }]);
  assert.equal(response.result.outcome, "succeeded");
  assert.equal(response.result.verification.status, "mismatched");
  assert.equal(response.isError, true);
});
