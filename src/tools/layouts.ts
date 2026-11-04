/** General Layout pool authoring. Uses structured bridge operations; never invokes assigned objects. */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, commandStep, notRequested, requestStep, runSteps, stepFromError, unavailable, validationFailure, valuesEqual, type OperationResult, type StepResult, type Verification } from "../results.js";
import { objectName, noteText, Validator } from "../validate.js";
import { isNotFoundError } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { inDataPool } from "./datapool.js";
import { lockState } from "./playback.js";
import { checkPoolName } from "./poolnames.js";

const numberSchema = z.number().int().min(1).max(9999);
const coordinateSchema = z.number().int().min(-32768).max(32767);
const dimensionSchema = z.number().int().min(1).max(32767);
// The Lua JSON library serialises an empty table as []; only that empty form is a field map.
const fieldSchema = z.preprocess((value) => Array.isArray(value) && value.length === 0 ? {} : value, z.record(z.string(), z.unknown()));
const summarySchema = z.object({
  name: z.string().optional(), class: z.string().optional(), addr: z.string().optional(), index: z.number().int().optional(), childCount: z.number().int().optional(), invalid: z.boolean().optional(), fields: fieldSchema.optional(), fieldErrors: fieldSchema.optional(),
}).passthrough();
const listingSchema = z.object({ total: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional(), items: z.array(summarySchema), enumerationError: z.unknown().optional() }).passthrough();
const propertySchema = z.object({ name: z.string(), readOnly: z.boolean().optional(), type: z.string().optional(), enum: z.string().optional() }).passthrough();
const objectSchema = summarySchema.extend({ properties: fieldSchema.optional(), schema: z.array(propertySchema).optional() });
const setReplySchema = z.object({ value: z.unknown().optional(), exact: z.unknown().optional(), readOk: z.boolean().optional(), readError: z.unknown().optional() }).passthrough();
type Summary = z.infer<typeof summarySchema>;
type ObjectRead = z.infer<typeof objectSchema>;

export const LAYOUT_FIELDS = ["No", "Name", "Note", "GUID", "Lock", "StructureLocked", "SystemLocked", "PositionX", "PositionY", "DimensionW", "DimensionH", "Appearance", "CanvasAppearance", "ViewPosActive", "ViewPosScale", "ViewPosX", "ViewPosY", "Markers", "ValueColors"];
export const ELEMENT_FIELDS = ["No", "Name", "GUID", "Lock", "StructureLocked", "SystemLocked", "Object", "Action", "PosX", "PosY", "Width", "Height", "Appearance", "CustomTextText", "CustomTextColor", "CustomTextSize", "CustomTextAlignmentH", "CustomTextAlignmentV", "CustomTextVertical", "VisibilityElement", "VisibilityObjectName", "VisibilityID", "VisibilityCID", "VisibilityBar", "VisibilityValue", "VisibilityIcon", "VisibilityIndicatorBar", "VisibilityBorder"];
const MAX_ELEMENTS = 10000;
const MAX_EDITS = 100;
const layoutRef = (layout: number) => `Layout ${layout}`;
const elementRef = (layout: number, element: number) => `Layout ${layout}.${element}`;
const upperFields = (fields: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toUpperCase(), value]));
const field = (item: Summary, name: string): unknown => upperFields(item.fields)[name.toUpperCase()];
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

async function listing(bridge: Gma3Bridge, ref: string, fields: string[], limit: number, offset: number, t: number, asText = true) {
  const result = listingSchema.parse(await bridge.request("children", { ref, fields, limit, offset, asText }, t));
  if (result.enumerationError !== undefined && result.enumerationError !== null) throw new Error(`Cannot list ${ref}: ${String(result.enumerationError)}`);
  for (const item of result.items) {
    if (item.invalid) throw new Error(`${ref} contains an invalid object; inspect again before editing`);
    if (item.fieldErrors && Object.keys(item.fieldErrors).length) throw new Error(`${ref} has unreadable fields: ${JSON.stringify(item.fieldErrors)}`);
  }
  return result;
}
async function one(bridge: Gma3Bridge, ref: string, fields: string[], t: number, asText = true): Promise<Summary | null> {
  try {
    const result = listingSchema.parse(await bridge.request("objects", { ref, fields, limit: 1, asText }, t));
    const item = result.items[0];
    if (!item || item.invalid) return null;
    if (item.fieldErrors && Object.keys(item.fieldErrors).length) throw new Error(`${ref} has unreadable fields: ${JSON.stringify(item.fieldErrors)}`);
    return item;
  } catch (err) { if (isNotFoundError(err)) return null; throw err; }
}
async function schemaRead(bridge: Gma3Bridge, ref: string, t: number): Promise<ObjectRead> {
  const result = objectSchema.parse(await bridge.request("object", { ref, schema: true, properties: true, asText: false }, t));
  if (result.invalid) throw new Error(`${ref} is invalid`);
  return result;
}
async function elementPage(bridge: Gma3Bridge, layout: number, limit: number, offset: number, t: number) {
  const display = await listing(bridge, layoutRef(layout), ELEMENT_FIELDS, limit, offset, t);
  const handles = await listing(bridge, layoutRef(layout), ["Object"], limit, offset, t, false);
  if (display.total !== handles.total || display.items.length !== handles.items.length) throw new Error("Layout changed between GUID and object-handle reads; inspect again");
  const items = display.items.map((item, index) => {
    const typed = handles.items[index];
    if (!typed || typed.addr !== item.addr || typed.index !== item.index) throw new Error("Layout element addresses changed between reads; inspect again");
    return { ...item, fields: { ...item.fields, Object: field(typed, "Object") } };
  });
  return { ...display, items };
}
async function allElements(bridge: Gma3Bridge, layout: number, t: number): Promise<Summary[]> {
  const items: Summary[] = [];
  let total: number | undefined;
  for (;;) {
    const page = await elementPage(bridge, layout, 500, items.length, t);
    if (page.total > MAX_ELEMENTS) throw new Error(`Layout ${layout} has more than ${MAX_ELEMENTS} elements; this authoring tool refuses an incomplete identity check`);
    if (total !== undefined && total !== page.total) throw new Error(`Layout ${layout} membership changed between pages; inspect again`);
    total = page.total;
    items.push(...page.items);
    if (items.length > total) throw new Error(`Layout ${layout} returned more elements than its reported total`);
    if (items.length >= page.total) return items;
    if (!page.items.length) throw new Error(`Layout ${layout} element enumeration stopped before all ${page.total} elements were read`);
  }
}
function elementState(item: Summary) {
  const no = Number(field(item, "No") ?? item.index);
  return { element: Number.isInteger(no) && no > 0 ? no : null, guid: stringValue(field(item, "GUID")) ?? null, ref: item.addr ?? null, name: item.name ?? null, class: item.class ?? null, fields: upperFields(item.fields) };
}
function writable(item: Summary, ref: string): void {
  for (const name of ["Lock", "StructureLocked", "SystemLocked"]) {
    const state = lockState(field(item, name));
    if (state !== false) throw new Error(`${ref} ${name} is ${state === true ? "enabled" : "unreadable"}; no edit was sent`);
  }
}
function writableProperties(object: ObjectRead, ref: string, properties: string[]): void {
  for (const property of properties) {
    const found = object.schema?.find((p) => p.name.toUpperCase() === property.toUpperCase());
    if (!found || found.readOnly !== false) throw new Error(`${ref}.${property} is ${found?.readOnly === true ? "read-only" : "not confirmed writable by the live schema"}`);
  }
}

const readShape = { data_pool: numberSchema, layout: numberSchema.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100), schema: z.boolean().default(false) };
const readSchema = z.object(readShape).strict();
export async function readLayouts(ctx: ToolContext, raw: unknown): Promise<unknown> {
  const args = readSchema.parse(raw);
  const scoped = inDataPool(ctx, args);
  const { bridge, requestTimeoutMs: t } = scoped;
  if (args.layout === undefined) return { data_pool: args.data_pool, ...(await listing(bridge, "DataPool.Layouts", LAYOUT_FIELDS, args.limit, args.offset, t)) };
  const ref = layoutRef(args.layout);
  const layout = await one(bridge, ref, LAYOUT_FIELDS, t);
  if (!layout) return { data_pool: args.data_pool, layout: args.layout, exists: false };
  const elements = await elementPage(bridge, args.layout, args.limit, args.offset, t);
  const metadata = args.schema ? await schemaRead(bridge, ref, t) : undefined;
  return { data_pool: args.data_pool, layout: args.layout, exists: true, ref: layout.addr, name: layout.name, fields: upperFields(layout.fields), total: elements.total, offset: args.offset, count: elements.items.length, incomplete: args.offset + elements.items.length < elements.total, elements: elements.items.map(elementState), ...(metadata ? { schema: metadata.schema } : {}) };
}

interface Write { property: string; value: string; expected: unknown; literal?: boolean }
async function readAction(name: string, op: string, run: () => Promise<unknown>): Promise<StepResult> {
  try { return asRead({ name, op, status: "succeeded", detail: await run() }); }
  catch (err) { return asRead(stepFromError(name, err, { op })); }
}
function writeStep(ctx: ToolContext, name: string, ref: string, write: Write): Promise<StepResult> {
  return requestStep(ctx.bridge, name, "set", { ref, property: write.property, value: write.value }, (raw) => {
    const parsed = setReplySchema.safeParse(raw);
    if (!parsed.success || parsed.data.readOk !== true) return { name, op: "set", status: "unknown", error: `The write was dispatched but ${ref}.${write.property} could not be read back; inspect before retrying`, detail: raw };
    const actual = parsed.data.exact ?? parsed.data.value;
    if (!(write.literal ? write.expected === actual : valuesEqual(write.expected, actual))) return { name, op: "set", status: "failed", error: `${ref}.${write.property} did not match the requested value`, detail: { expected: write.expected, actual } };
    return { name, op: "set", status: "succeeded", detail: { property: write.property, value: actual } };
  }, ctx.requestTimeoutMs);
}
function skip(names: string[], reason: string): StepResult[] { return names.map((name) => ({ name, status: "skipped", error: reason })); }
function verifyWrites(checked: string, writes: Write[], actual: Record<string, unknown>): Verification {
  const mismatches: string[] = [];
  for (const write of writes) {
    const got = actual[write.property.toUpperCase()];
    if (!(write.literal ? write.expected === got : valuesEqual(write.expected, got))) mismatches.push(`${write.property}: expected ${JSON.stringify(write.expected)}, read ${JSON.stringify(got)}`);
  }
  return { status: mismatches.length ? "mismatched" : "matched", checked, ...(mismatches.length ? { detail: mismatches.join("; ") } : {}) };
}

function writesFrom(values: Record<string, unknown>, mappings: Record<string, string>): Write[] {
  const out: Write[] = [];
  for (const [key, property] of Object.entries(mappings)) {
    const value = values[key];
    if (value === undefined) continue;
    // ViewPosScale accepts a ratio but its edit/read roles display percent (0.8 -> 80).
    const expected = property === "ViewPosScale" && typeof value === "number" ? value * 100 : value;
    out.push({ property, value: typeof value === "boolean" ? value ? "Yes" : "No" : String(value), expected, literal: ["Name", "Note", "CustomTextText"].includes(property) });
  }
  return out;
}
const layoutShape = {
  data_pool: numberSchema, layout: numberSchema, mode: z.enum(["create", "update"]), name: z.string().optional(), note: z.string().max(2048).optional(),
  canvas_x: coordinateSchema.optional(), canvas_y: coordinateSchema.optional(), canvas_width: dimensionSchema.optional(), canvas_height: dimensionSchema.optional(),
  view_position_active: z.boolean().optional(), view_x: z.number().int().min(-2147483648).max(2147483647).optional(), view_y: z.number().int().min(-2147483648).max(2147483647).optional(), view_scale: z.number().positive().max(10000).optional(),
  markers: z.boolean().optional(), value_colors: z.boolean().optional(), preview: z.boolean().default(false),
};
const storeSchema = z.object(layoutShape).strict();
const LAYOUT_MAPPING = { name: "Name", note: "Note", canvas_x: "PositionX", canvas_y: "PositionY", canvas_width: "DimensionW", canvas_height: "DimensionH", view_position_active: "ViewPosActive", view_x: "ViewPosX", view_y: "ViewPosY", view_scale: "ViewPosScale", markers: "Markers", value_colors: "ValueColors" };

export async function storeLayout(ctx: ToolContext, raw: unknown): Promise<OperationResult> {
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) return validationFailure("store_layout", {}, parsed.error.issues.map((issue) => issue.message));
  const args = parsed.data;
  const target = { data_pool: args.data_pool, layout: args.layout, mode: args.mode };
  const v = new Validator();
  const name = args.name === undefined ? undefined : v.check(() => objectName("name", args.name));
  const note = args.note === undefined ? undefined : v.check(() => noteText("note", args.note, { maxLength: 2048 }));
  if (!v.ok) return validationFailure("store_layout", target, v.errors);
  const writes = writesFrom({ ...args, name, note }, LAYOUT_MAPPING);
  if (args.mode === "update" && !writes.length) return validationFailure("store_layout", target, ["update requires at least one supplied setting"]);
  const scoped = inDataPool(ctx, args);
  const ref = layoutRef(args.layout);
  const planned = [...(args.mode === "create" ? [{ op: "cmd", command: scoped.bridge.sentCommand?.(`Store ${ref} /NoConfirmation`) ?? `Store ${ref} /NoConfirmation` }] : []), ...writes.map((write) => ({ op: "set", ref: `DataPool ${args.data_pool} ${ref}`, property: write.property, value: write.value }))];
  const body = async () => {
    const steps: StepResult[] = [];
    let before: Summary | null = null;
    steps.push(await readAction("inspect_layout", "objects", async () => {
      before = await one(scoped.bridge, ref, LAYOUT_FIELDS, scoped.requestTimeoutMs);
      if (args.mode === "create" && before) throw new Error(`${ref} already exists; create refuses overwrite`);
      if (args.mode === "update" && !before) throw new Error(`${ref} does not exist; update never creates it`);
      if (before) writable(before, ref);
      return before;
    }));
    if (steps[0]?.status === "succeeded" && name !== undefined) {
      steps.push(await readAction("check_name", "children", async () => {
        const result = await checkPoolName({ bridge: scoped.bridge, t: scoped.requestTimeoutMs, pool: { ref: "DataPool.Layouts", noun: "layout", plural: "layouts", label: layoutRef }, cache: new Map(), number: args.layout, name, onNameTaken: "refuse", warnings: [], keepOwn: true });
        if (result.status !== "succeeded") throw new Error(result.error ?? "Layout name collision check failed");
        return result.detail;
      }));
    }
    if (steps.every((step) => step.status === "succeeded") && args.mode === "update") steps.push(await readAction("inspect_schema", "object", async () => {
      const object = await schemaRead(scoped.bridge, ref, scoped.requestTimeoutMs);
      writableProperties(object, ref, writes.map((write) => write.property));
      return object.schema;
    }));
    if (steps.some((step) => step.status !== "succeeded")) return buildResult({ operation: "store_layout", target, steps, verification: unavailable("preflight refused before any mutation"), extra: { preview: args.preview, planned } });
    if (args.preview) return buildResult({ operation: "store_layout", target, steps, verification: notRequested(), summary: `Preview only: ${ref} would be ${args.mode === "create" ? "created" : "updated"}; no mutation was sent.`, extra: { preview: true, planned, before } });
    const plan = [];
    if (args.mode === "create") {
      plan.push({ name: "create_layout", run: () => commandStep(scoped.bridge, "create_layout", `Store ${ref} /NoConfirmation`, scoped.requestTimeoutMs) });
      plan.push({ name: "inspect_created_schema", run: () => readAction("inspect_created_schema", "object", async () => {
        const object = await schemaRead(scoped.bridge, ref, scoped.requestTimeoutMs);
        if (object.class !== "Layout") throw new Error(`${ref} was not created as a Layout`);
        writableProperties(object, ref, writes.map((write) => write.property));
        return object.schema;
      }) });
    }
    for (const write of writes) plan.push({ name: `set_${write.property}`, run: () => writeStep(scoped, `set_${write.property}`, ref, write) });
    const mutation = await runSteps(plan);
    steps.push(...mutation.steps);
    const after: { resulting: Summary | null } = { resulting: null };
    const readBack = await readAction("read_back", "objects", async () => {
      const resulting = await one(scoped.bridge, ref, LAYOUT_FIELDS, scoped.requestTimeoutMs);
      if (!resulting || resulting.class !== "Layout") throw new Error(`${ref} could not be read back as a Layout`);
      after.resulting = resulting;
      return resulting;
    });
    steps.push(readBack);
    const resulting = after.resulting;
    const verification = readBack.status === "succeeded" && resulting ? verifyWrites("Layout existence and supplied fields", writes, upperFields(resulting.fields)) : unavailable("Layout read-back failed");
    return buildResult({ operation: "store_layout", target, steps, verification, warnings: ["Serialisation covers this MCP server only; another operator or client can change the layout between inspection and a write."], extra: { preview: false, planned, before, resulting } });
  };
  return args.preview ? body() : ctx.mutations.run(body);
}

// Values captured from the live 2.5.1.1 enum collections; actions are narrowed by the assigned class.
const objectTargetSchema = z.object({ type: z.enum(["Macro", "Sequence", "Group"]), number: numberSchema }).strict();
const visibilityValue = z.enum(["Visible", "Hidden"]);
const visibilitySchema = z.object({ element: visibilityValue.optional(), object_name: visibilityValue.optional(), id: visibilityValue.optional(), cid: visibilityValue.optional(), bar: visibilityValue.optional(), value: visibilityValue.optional(), icon: visibilityValue.optional(), indicator_bar: visibilityValue.optional(), border: visibilityValue.optional() }).strict();
const changeShape = {
  object: objectTargetSchema.optional(), replace_object: z.boolean().default(false),
  x: coordinateSchema.optional(), y: coordinateSchema.optional(), width: dimensionSchema.optional(), height: dimensionSchema.optional(),
  action: z.string().min(1).max(40).optional(), appearance: numberSchema.optional(),
  custom_text: z.string().max(2048).regex(/^[^\x00-\x1f\x7f]*$/, "custom_text must contain no control characters or line breaks").refine((value) => value.trim() === value, "custom_text leading/trailing whitespace cannot be independently verified; use padding fields in a later feature").optional(),
  custom_text_color: z.string().regex(/^[0-9a-fA-F]{8}$/, "colour must be eight hexadecimal RGBA digits, e.g. 11AA33FF").transform((value) => value.toUpperCase()).optional(),
  custom_text_size: z.enum(["9", "11", "14", "16", "18", "20", "24", "28", "32"]).optional(),
  custom_text_align_h: z.enum(["Center", "Left", "Right", "OutsideLeft", "OutsideRight"]).optional(),
  custom_text_align_v: z.enum(["Center", "Top", "Bottom", "Above", "Below"]).optional(),
  custom_text_vertical: z.boolean().optional(), visibility: visibilitySchema.optional(),
};
const identitySchema = z.object({ element: numberSchema, guid: z.string().min(1).max(200) }).strict();
const addSchema = z.object({ ...changeShape, operation: z.literal("add"), x: coordinateSchema, y: coordinateSchema, width: dimensionSchema, height: dimensionSchema }).strict();
const updateSchema = z.object({ ...changeShape, operation: z.literal("update"), identity: identitySchema }).strict();
const removeSchema = z.object({ operation: z.literal("remove"), identity: identitySchema }).strict();
const editShape = { data_pool: numberSchema, layout: numberSchema, edits: z.array(z.discriminatedUnion("operation", [addSchema, updateSchema, removeSchema])).min(1).max(MAX_EDITS), preview: z.boolean().default(false) };
const editSchema = z.object(editShape).strict();
type Edit = z.infer<typeof editSchema>["edits"][number];
type Change = z.infer<typeof updateSchema> | z.infer<typeof addSchema>;
const ELEMENT_MAPPING = { x: "PosX", y: "PosY", width: "Width", height: "Height", action: "Action", custom_text: "CustomTextText", custom_text_color: "CustomTextColor", custom_text_size: "CustomTextSize", custom_text_align_h: "CustomTextAlignmentH", custom_text_align_v: "CustomTextAlignmentV", custom_text_vertical: "CustomTextVertical" };
const VISIBILITY_MAPPING = { element: "VisibilityElement", object_name: "VisibilityObjectName", id: "VisibilityID", cid: "VisibilityCID", bar: "VisibilityBar", value: "VisibilityValue", icon: "VisibilityIcon", indicator_bar: "VisibilityIndicatorBar", border: "VisibilityBorder" };
const ACTIONS: Record<string, Set<string>> = {
  Macro: new Set(["<<<", ">>>", "Call", "Go+", "Go-", "Off", "Pause"]),
  Group: new Set(["SelectFixtures"]),
  Sequence: new Set(["Go+", "Go-", "<<<", ">>>", "On", "Off", "Toggle", "Top", "Kill", "Pause", "Goto", "Load", "Select", "SelectFixtures", "Rate1", "Speed1", "Learn", "LearnSpeed", "HalfSpeed", "DoubleSpeed", "ReSync", "FastSync", "Flash", "Temp", "Swap", "Black", "Time"]),
};
function changes(edit: Change): Write[] {
  return [...writesFrom(edit, ELEMENT_MAPPING), ...writesFrom(edit.visibility ?? {}, VISIBILITY_MAPPING)];
}
function assigned(item: Summary): Summary | null {
  const value = field(item, "Object");
  if (value === undefined || value === null || value === "") return null;
  const result = summarySchema.safeParse(value);
  if (!result.success) throw new Error("Assigned object is not a typed handle; emptiness cannot be established");
  if (result.data.invalid) return null;
  if (!result.data.addr || !result.data.class) throw new Error("Assigned object has no readable class/address; inspect again before editing");
  return result.data;
}
function assignmentMatches(item: Summary, address: string): boolean {
  try { return assigned(item)?.addr === address; }
  catch { return false; }
}
function identityItem(items: Summary[], identity: z.infer<typeof identitySchema>): Summary {
  const item = items.find((candidate) => elementState(candidate).element === identity.element);
  if (!item || elementState(item).guid !== identity.guid) throw new Error(`Element ${identity.element} no longer has GUID ${identity.guid}; read the layout again before editing`);
  return item;
}
interface PreparedEdit { edit: Edit; object?: Summary; appearance?: Summary; writes: Write[] }

export async function editLayoutElements(ctx: ToolContext, raw: unknown): Promise<OperationResult> {
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) return validationFailure("edit_layout_elements", {}, parsed.error.issues.map((issue) => issue.message));
  const args = parsed.data;
  const scoped = inDataPool(ctx, args);
  const target = { data_pool: args.data_pool, layout: args.layout };
  const ref = layoutRef(args.layout);
  const body = async () => {
    const steps: StepResult[] = [];
    const prepared: PreparedEdit[] = [];
    const snapshot: { items: Summary[] } = { items: [] };
    steps.push(await readAction("inspect_layout", "objects", async () => {
      const item = await one(scoped.bridge, ref, LAYOUT_FIELDS, scoped.requestTimeoutMs);
      if (!item || item.class !== "Layout") throw new Error(`${ref} does not exist as a Layout`);
      writable(item, ref);
      return item;
    }));
    if (steps[0]?.status === "succeeded") steps.push(await readAction("inspect_elements", "children", async () => {
      snapshot.items = await allElements(scoped.bridge, args.layout, scoped.requestTimeoutMs);
      if (snapshot.items.some((item) => item.class !== "Element")) throw new Error("Layout has an unexpected child class; edit refused");
      const identities = snapshot.items.map((item) => elementState(item).guid);
      if (identities.some((guid) => !guid) || new Set(identities).size !== identities.length) throw new Error("Every existing element must have a readable, unique GUID before editing");
      const numbers = snapshot.items.map((item) => elementState(item).element);
      if (numbers.some((number) => number === null) || new Set(numbers).size !== numbers.length) throw new Error("Every existing element must have a readable, unique number before editing");
      return snapshot.items.map(elementState);
    }));
    const used = new Set<string>();
    for (const [index, edit] of args.edits.entries()) {
      const name = `check_edit_${index + 1}`;
      if (steps.some((step) => step.status !== "succeeded")) { steps.push(...skip([name], "earlier preflight failed")); continue; }
      steps.push(await readAction(name, "objects", async () => {
        let item: Summary | undefined;
        if (edit.operation !== "add") {
          if (used.has(edit.identity.guid)) throw new Error(`GUID ${edit.identity.guid} is targeted more than once in edits`);
          used.add(edit.identity.guid);
          item = identityItem(snapshot.items, edit.identity);
          writable(item, elementRef(args.layout, edit.identity.element));
        }
        const writes = edit.operation === "remove" ? [] : changes(edit);
        const preparedEdit: PreparedEdit = { edit, writes };
        if (edit.operation !== "remove" && edit.object) {
          const objectRef = `${edit.object.type} ${edit.object.number}`;
          const object = await one(scoped.bridge, objectRef, ["Name"], scoped.requestTimeoutMs, false);
          if (!object || object.class !== edit.object.type || !object.addr || !/^\d+(?:\.\d+)*$/.test(object.addr)) throw new Error(`${objectRef} has no readable matching object handle`);
          const previous = item ? assigned(item) : null;
          if (previous && previous.addr !== object.addr && !edit.replace_object) throw new Error(`Element ${edit.operation === "update" ? edit.identity.element : "new"} already holds ${previous.class} ${previous.name}; replace_object: true is required`);
          preparedEdit.object = object;
        }
        if (edit.operation !== "remove" && edit.appearance !== undefined) {
          const appearance = await one(scoped.bridge, `Appearance ${edit.appearance}`, ["Name"], scoped.requestTimeoutMs, false);
          if (!appearance || appearance.class !== "Appearance" || !appearance.addr || !/^\d+(?:\.\d+)*$/.test(appearance.addr)) throw new Error(`Appearance ${edit.appearance} has no readable matching handle`);
          preparedEdit.appearance = appearance;
        }
        if (edit.operation !== "remove" && edit.action !== undefined) {
          const object = preparedEdit.object ?? (item ? assigned(item) : null);
          const allowed = object?.class ? ACTIONS[object.class] : undefined;
          if (!allowed?.has(edit.action)) throw new Error(`Action ${edit.action} is not supported for ${object?.class ?? "an unassigned element"}; supported: ${allowed ? [...allowed].join(", ") : "none"}`);
        }
        if (edit.operation === "update" && !writes.length && !preparedEdit.object && !preparedEdit.appearance) throw new Error("update requires at least one changed setting or object assignment");
        if (item && edit.operation !== "add") {
          const schema = await schemaRead(scoped.bridge, elementRef(args.layout, edit.identity.element), scoped.requestTimeoutMs);
          writableProperties(schema, ref, [...writes.map((write) => write.property), ...(preparedEdit.object ? ["Object"] : []), ...(preparedEdit.appearance ? ["Appearance"] : [])]);
        }
        prepared.push(preparedEdit);
        return { operation: edit.operation, ...(edit.operation === "add" ? {} : { identity: edit.identity }), writes, object: preparedEdit.object, appearance: preparedEdit.appearance };
      }));
    }
    const planned = prepared.map((item) => ({ operation: item.edit.operation, ...(item.edit.operation === "add" ? { new_element: "append" } : { identity: item.edit.identity }), ...(item.object ? { object_address: item.object.addr } : {}), writes: item.writes, ...(item.appearance ? { appearance_address: item.appearance.addr } : {}) }));
    if (steps.some((step) => step.status !== "succeeded")) return buildResult({ operation: "edit_layout_elements", target, steps, verification: unavailable("preflight failed; no mutation was sent"), extra: { preview: args.preview, planned } });
    if (args.preview) return buildResult({ operation: "edit_layout_elements", target, steps, summary: `Preview only: ${prepared.length} element edit(s) validated; no mutation was sent. New element schemas are checked after creation.`, extra: { preview: true, planned, before: snapshot.items.map(elementState) } });
    return executeElementEdits(scoped, args.layout, target, prepared, snapshot.items, steps, planned);
  };
  return args.preview ? body() : ctx.mutations.run(body);
}

async function executeElementEdits(ctx: ToolContext, layout: number, target: Record<string, unknown>, prepared: PreparedEdit[], before: Summary[], steps: StepResult[], planned: unknown[]): Promise<OperationResult> {
  const state: { current: Summary[]; item?: Summary; guid?: string } = { current: before };
  const expectations: Array<{ operation: string; guid: string; writes: Write[]; object?: string; appearance?: string }> = [];
  let stopped = false;
  for (const [index, item] of prepared.entries()) {
    const prefix = `edit_${index + 1}`;
    if (stopped) { steps.push(...skip([prefix], "an earlier mutation failed or is uncertain")); continue; }
    const edit = item.edit;
    const refresh = await readAction(`${prefix}_recheck`, "children", async () => {
      const owner = await one(ctx.bridge, layoutRef(layout), LAYOUT_FIELDS, ctx.requestTimeoutMs);
      if (!owner) throw new Error("Layout disappeared before mutation");
      writable(owner, layoutRef(layout));
      const current = await allElements(ctx.bridge, layout, ctx.requestTimeoutMs);
      const expected = state.current.map((entry) => elementState(entry).guid).sort();
      const actual = current.map((entry) => elementState(entry).guid).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Layout membership changed since preflight; read it again before editing");
      state.current = current;
      if (edit.operation !== "add") {
        const existing = current.find((entry) => elementState(entry).guid === edit.identity.guid);
        if (!existing) throw new Error("Target GUID disappeared before mutation");
        const number = elementState(existing).element;
        if (number === null) throw new Error("Target element has no readable number");
        writable(existing, elementRef(layout, number));
        const old = before.find((entry) => elementState(entry).guid === edit.identity.guid);
        if (!old || assigned(old)?.addr !== assigned(existing)?.addr) throw new Error("Element assignment changed since preflight; read it again before editing");
        state.item = existing;
        state.guid = edit.identity.guid;
      }
      return current.map(elementState);
    });
    steps.push(refresh);
    if (refresh.status !== "succeeded") { stopped = true; continue; }
    if (edit.operation === "add") {
      const next = Math.max(0, ...state.current.map((entry) => elementState(entry).element ?? 0)) + 1;
      if (next > 9999) { steps.push({ name: `${prefix}_create`, status: "failed", kind: "read", error: "Next element number exceeds the supported 9999 bound" }); stopped = true; continue; }
      const create = await commandStep(ctx.bridge, `${prefix}_create`, `Store ${elementRef(layout, next)} /NoConfirmation`, ctx.requestTimeoutMs);
      steps.push(create);
      if (create.status !== "succeeded") { stopped = true; continue; }
      const inspect = await readAction(`${prefix}_identify_created`, "children", async () => {
        const after = await allElements(ctx.bridge, layout, ctx.requestTimeoutMs);
        const previous = new Set(state.current.map((entry) => elementState(entry).guid));
        const added = after.filter((entry) => !previous.has(elementState(entry).guid));
        if (after.length !== state.current.length + 1 || added.length !== 1 || state.current.some((entry) => !after.some((candidate) => elementState(candidate).guid === elementState(entry).guid))) throw new Error("Creation did not add exactly one new GUID while preserving every prior element; inspect before continuing");
        const created = added[0];
        if (!created || !elementState(created).guid || elementState(created).element !== next) throw new Error("Created element has no unambiguous GUID/number");
        writable(created, elementRef(layout, next));
        state.item = created;
        state.guid = elementState(created).guid ?? undefined;
        state.current = after;
        return elementState(created);
      });
      steps.push(inspect);
      if (inspect.status !== "succeeded") { stopped = true; continue; }
    }
    const selected = state.item;
    const guid = state.guid;
    const number = selected ? elementState(selected).element : null;
    if (!selected || !guid || number === null) { steps.push({ name: prefix, status: "failed", kind: "read", error: "No confirmed element identity; mutation refused" }); stopped = true; continue; }
    const ref = elementRef(layout, number);
    expectations.push({ operation: edit.operation, guid, writes: item.writes, object: item.object?.addr, appearance: item.appearance?.addr });
    if (edit.operation === "remove") {
      const remove = await commandStep(ctx.bridge, `${prefix}_remove`, `Delete ${ref} /NoConfirmation`, ctx.requestTimeoutMs);
      steps.push(remove);
      if (remove.status !== "succeeded") { stopped = true; continue; }
      const verifyRemove = await readAction(`${prefix}_verify_removed`, "children", async () => {
        const after = await allElements(ctx.bridge, layout, ctx.requestTimeoutMs);
        const remaining = state.current.filter((entry) => elementState(entry).guid !== guid).map((entry) => elementState(entry).guid).sort();
        if (JSON.stringify(remaining) !== JSON.stringify(after.map((entry) => elementState(entry).guid).sort())) throw new Error("Delete did not remove exactly the requested GUID; inspect before continuing");
        state.current = after;
        return { removed: guid, remaining: after.map(elementState) };
      });
      steps.push(verifyRemove);
      stopped = verifyRemove.status !== "succeeded";
      continue;
    }
    const schemaStep = await readAction(`${prefix}_schema`, "object", async () => {
      const schema = await schemaRead(ctx.bridge, ref, ctx.requestTimeoutMs);
      writableProperties(schema, ref, [...item.writes.map((write) => write.property), ...(item.object ? ["Object"] : []), ...(item.appearance ? ["Appearance"] : [])]);
      return schema.schema;
    });
    steps.push(schemaStep);
    if (schemaStep.status !== "succeeded") { stopped = true; continue; }
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    const object = item.object;
    if (object?.addr) {
      plan.push({ name: `${prefix}_assign`, run: () => requestStep(ctx.bridge, `${prefix}_assign`, "set", { ref, property: "Object", value: object.addr }, (raw) => {
        const result = setReplySchema.safeParse(raw);
        return result.success && result.data.readOk === true ? { name: `${prefix}_assign`, op: "set", status: "succeeded", detail: result.data } : { name: `${prefix}_assign`, op: "set", status: "unknown", error: "Object assignment was dispatched but its immediate read failed; inspect before retrying", detail: raw };
      }, ctx.requestTimeoutMs) });
      plan.push({ name: `${prefix}_verify_assignment`, run: () => readAction(`${prefix}_verify_assignment`, "objects", async () => {
        const actual = await one(ctx.bridge, ref, ["Object"], ctx.requestTimeoutMs, false);
        if (!actual || assigned(actual)?.addr !== object.addr) throw new Error(`Object assignment does not match ${object.class} at ${object.addr}`);
        return assigned(actual);
      }) });
    }
    const appearance = item.appearance;
    const appearanceState: { token?: string } = {};
    if (appearance?.addr) {
      plan.push({ name: `${prefix}_appearance`, run: () => requestStep(ctx.bridge, `${prefix}_appearance`, "set", { ref, property: "Appearance", value: appearance.addr }, (raw) => {
        const result = setReplySchema.safeParse(raw);
        if (!result.success || result.data.readOk !== true) return { name: `${prefix}_appearance`, op: "set", status: "unknown", error: "Appearance write could not be read back; inspect before retrying", detail: raw };
        const token = result.data.value;
        if (typeof token !== "string" || !/^#[0-9a-f]+$/i.test(token)) return { name: `${prefix}_appearance`, op: "set", status: "failed", error: "Appearance did not become a resolvable encoded handle", detail: raw };
        appearanceState.token = token;
        return { name: `${prefix}_appearance`, op: "set", status: "succeeded", detail: { token } };
      }, ctx.requestTimeoutMs) });
      plan.push({ name: `${prefix}_verify_appearance`, run: () => readAction(`${prefix}_verify_appearance`, "object", async () => {
        if (!appearanceState.token) throw new Error("No appearance handle was returned");
        const actual = objectSchema.parse(await ctx.bridge.request("object", { ref: appearanceState.token, properties: false }, ctx.requestTimeoutMs));
        if (actual.class !== "Appearance" || actual.addr !== appearance.addr) throw new Error("Resolved appearance does not match the requested appearance address");
        return actual;
      }) });
    }
    for (const write of item.writes) plan.push({ name: `${prefix}_set_${write.property}`, run: () => writeStep(ctx, `${prefix}_set_${write.property}`, ref, write) });
    const mutation = await runSteps(plan);
    steps.push(...mutation.steps);
    stopped = mutation.outcome !== "succeeded";
  }
  const after: { items?: Summary[] } = {};
  const readBack = await readAction("read_back_elements", "children", async () => { after.items = await allElements(ctx.bridge, layout, ctx.requestTimeoutMs); return after.items.map(elementState); });
  steps.push(readBack);
  let verification: Verification = unavailable(after.items ? "No requested mutation had a confirmed element identity to verify" : "Element read-back failed");
  if (after.items && expectations.length) {
    const mismatches: string[] = [];
    for (const expected of expectations) {
      const actual = after.items.find((entry) => elementState(entry).guid === expected.guid);
      if (expected.operation === "remove") { if (actual) mismatches.push(`GUID ${expected.guid} still exists`); continue; }
      if (!actual) { mismatches.push(`GUID ${expected.guid} is missing`); continue; }
      const compared = verifyWrites(`Element ${expected.guid} supplied fields`, expected.writes, upperFields(actual.fields));
      if (compared.status !== "matched") mismatches.push(compared.detail ?? "Element fields could not be compared");
      if (expected.object && !assignmentMatches(actual, expected.object)) mismatches.push(`GUID ${expected.guid} assignment does not match ${expected.object}`);
      if (expected.appearance) {
        const checkAppearance = await readAction(`read_back_appearance_${expected.guid}`, "object", async () => {
          const token = field(actual, "Appearance");
          if (typeof token !== "string" || !/^#[0-9a-f]+$/i.test(token)) throw new Error("Appearance token is unreadable");
          const resolved = objectSchema.parse(await ctx.bridge.request("object", { ref: token, properties: false }, ctx.requestTimeoutMs));
          if (resolved.class !== "Appearance" || resolved.addr !== expected.appearance) throw new Error("Appearance address does not match");
          return resolved;
        });
        steps.push(checkAppearance);
        if (checkAppearance.status !== "succeeded") mismatches.push(`GUID ${expected.guid} appearance could not be verified`);
      }
    }
    verification = { status: mismatches.length ? "mismatched" : "matched", checked: "Requested element GUIDs, supplied fields and assigned object addresses; retained elements are not rendered or invoked", ...(mismatches.length ? { detail: mismatches.join("; ") } : {}) };
  }
  return buildResult({ operation: "edit_layout_elements", target, steps, verification, warnings: ["Element numbers can shift after deletion. Use the returned GUID/current number identities for the next call. Serialisation covers this server only; other operators and clients are not isolated."], extra: { preview: false, planned, before: before.map(elementState), resulting: after.items?.map(elementState) ?? null } });
}

const AUTHORING_NOTE = "Does not select fixtures, clear programmer values, invoke layout elements, or execute assigned macros or sequences. Uses existing bridge operations without Lua, OSC fallback or automatic replay. Preview reads and validates without mutations. Mutations are serialised within this server, without isolation from another operator or client. Every property write requires read-back; uncertain writes stop the plan and require inspection before retrying. Layout Viewer window setup, grid and fit settings are outside this tool.";
export const registerLayoutTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_layouts", {
    title: "Read layouts and their elements",
    description: "Read the Layout pool or one layout in an explicit data pool using children/objects/object. Returns bounded element pages, current element numbers, GUID identities, assigned object handles and geometry, action, appearance, custom text and visibility fields. schema optionally returns the layout's live property schema. Read-only; no selection, programmer, playback or Viewer window changes. An incomplete page is explicitly flagged; read all pages before planning a broad edit.",
    inputSchema: readShape,
  }, async (args) => json(await readLayouts(ctx, args)));
  server.registerTool("gma3_edit_layout_elements", {
    title: "Add, update or remove layout elements",
    description: "Apply up to 100 explicit element edits in one existing layout and required data pool. Add requires integer x/y/width/height in layout units; positions are Int16 and dimensions 1..32767. Update/remove require the current element number and GUID from gma3_layouts; stale/duplicate identities, locks and read-only properties are refused. Never clears/rebuilds the layout. Add sends Store Layout n.k /NoConfirmation to append a blank element; assignment uses set Object with a resolved numeric address, never Assign At Layout n.k (which appends). Remove sends Delete Layout n.k /NoConfirmation for the confirmed GUID. Other supplied fields use one set each. Object assignment accepts Macro/Sequence/Group; replacing a different assignment requires replace_object:true. Actions are validated for the actual assigned object class. Appearance overrides use a global Appearance pool number, resolved and verified by encoded handle/address. Custom text preserves case, quotes and internal spaces; leading/trailing whitespace is refused because read-only bridge fields trim it. Custom text accepts RGBA hex colour, captured font-size enums and alignment; visibility accepts Visible/Hidden. Reads GUIDs and typed object handles separately, and verifies identities, supplied properties and object addresses after edits; visual rendering and actual action execution are not verified. " + AUTHORING_NOTE,
    inputSchema: editShape,
  }, async (args) => operation(() => editLayoutElements(ctx, args)));
  server.registerTool("gma3_store_layout", {
    title: "Create or update a layout",
    description: "Create a new empty layout or update only supplied layout fields in an explicit data pool. Create refuses an occupied number; names are checked against the pool. Sends Store Layout n /NoConfirmation only for create, then one set request per supplied field, followed by objects read-back. It never deletes or rebuilds elements. Canvas coordinates and dimensions use integer layout units; position/size are Int16, view coordinates Int32, view scale a positive ratio (0.8 = 80%; console read-back displays percent). Verifies existence and supplied fields, not rendered appearance. " + AUTHORING_NOTE,
    inputSchema: layoutShape,
  }, async (args) => operation(() => storeLayout(ctx, args)));
};
