/**
 * SB-01: executor assignments and sequence playback configuration.
 *
 *   gma3_executor_settings    read-only: an executor's functions and locks, its assigned object, the sequence's
 *                             playback settings and lock, playback state, and every executor sharing the sequence
 *   gma3_configure_executor   key / MA-key / fader / encoder functions and Fix of a sequence executor
 *   gma3_configure_sequence   Wrap Around, priority, restart mode and the other sequence playback options
 *
 * Executor settings belong to the executor (Page <p>.<e>); playback settings belong to the sequence and therefore
 * apply to every executor that references it. Both configure tools use the existing `set` op (one property per
 * request) and the `objects` / `object` / `children` read ops; no Lua is generated and no playback keyword is sent.
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-01-playback-macos-2.5.1.md):
 *   - Every setting is a plain property: the executor's KeyPress, KeyUnpress, MAKeyPress, MAKeyUnpress, Fader,
 *     Encoder, EncoderLeft, EncoderRight, Fix, Lock; the sequence's WrapAround, Priority, RestartMode, ... and Lock.
 *     `set` writes them and returns the value read back in the edit role.
 *   - An invalid value is SILENTLY IGNORED: the property keeps its previous value (KeyPress "Bogus", Fader
 *     "Highlight", EncoderLeft "Flash"). The console accepts key functions that do not apply to a sequence
 *     (Call, LogIn, At), so the allowed lists below are this module's, and every write is checked against the value
 *     the `set` op reads back.
 *   - A lock is per object: the Page, the Executor and the Sequence each have Lock (read "UL" when locked, "" when
 *     not). Writes to a locked executor (or to any executor of a locked page) and to a locked sequence are silently
 *     ignored; Store into a locked sequence answers "Cannot Create Object". A page lock does not protect the
 *     sequence. Kill Protect and Swap Protect protect the sequence from those playback actions, not from editing.
 *   - `Set Lock No` / `Set Lock Yes` unlock and lock again.
 *   - Configuring functions or sequence settings does not start playback (HasActivePlayback stays false); a Temp or
 *     Flash key is active exactly while pressed.
 *   - `Assign <function> At Page p.e` clears the unpress function (manual); property writes do not.
 *   - The executors that reference a sequence are found by walking DataPool.Pages with the `children` op and
 *     comparing each executor's Object address (about 0.1 s for 5 pages).
 *   - SB-06 (docs/probes/sb-06-speed-macos-2.5.1.md): SpeedMaster and RateMaster take a speed master's NAME ("Speed14";
 *     "14", "3.14" and "Master 3.14" are silently ignored) and read back as the name; RateMaster takes speed masters
 *     only. SpeedScale and RateScale are Enums.SpeedScale names. A rate master drives the cue timing (60 BPM = 1:1),
 *     a speed master the phasers.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { readObjects, type ObjectSummary } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { MAX_BATCH_ITEMS, batchOptionShape, batchRefused, duplicates, runBatchCall } from "../batch.js";
import { executorNumber, executorRef, pageNumber } from "./executors.js";
import {
  asRead,
  buildResult,
  commandStep,
  compareFields,
  notRequested,
  requestStep,
  runSteps,
  stepFromError,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, finiteNumber, objectNumber } from "../validate.js";
import { currentPoolBridge, dataPoolOf, dataPoolShape, inDataPool } from "./datapool.js";
import { commandText } from "./macros.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Button functions the console offers for a sequence (Enums.AssignmentButtonFunctionsSequence on 2.5.1, plus Empty). */
export const SEQUENCE_BUTTON_FUNCTIONS = [
  "Empty", "Go+", "Go-", "<<<", ">>>", "On", "Off", "Toggle", "Top", "Kill", "Pause", "Goto", "Load", "Select",
  "SelectFixtures", "Rate1", "Speed1", "Learn", "LearnSpeed", "HalfSpeed", "DoubleSpeed", "ReSync", "FastSync",
] as const;
/** Key-only functions for a sequence (the manual greys them out for encoders, and the console refuses them there). */
export const SEQUENCE_KEY_ONLY_FUNCTIONS = ["Flash", "Temp", "Swap", "Black", "Time"] as const;
/** Fader and encoder functions (Enums.AssignmentFaderFunctions, plus Empty). */
export const FADER_FUNCTIONS = ["Empty", "Master", "X", "XA", "XB", "Temp", "Rate", "Speed", "Time"] as const;

const KEY_PRESS = [...SEQUENCE_BUTTON_FUNCTIONS, ...SEQUENCE_KEY_ONLY_FUNCTIONS] as const;

/** Executor parameters -> property names and the functions allowed for a Sequence assignment. */
export const EXECUTOR_FUNCTIONS = {
  key_press: { property: "KeyPress", allowed: KEY_PRESS },
  key_unpress: { property: "KeyUnpress", allowed: SEQUENCE_BUTTON_FUNCTIONS },
  ma_key_press: { property: "MAKeyPress", allowed: KEY_PRESS },
  ma_key_unpress: { property: "MAKeyUnpress", allowed: SEQUENCE_BUTTON_FUNCTIONS },
  fader: { property: "Fader", allowed: FADER_FUNCTIONS },
  encoder: { property: "Encoder", allowed: FADER_FUNCTIONS },
  encoder_left: { property: "EncoderLeft", allowed: SEQUENCE_BUTTON_FUNCTIONS },
  encoder_right: { property: "EncoderRight", allowed: SEQUENCE_BUTTON_FUNCTIONS },
  ma_encoder: { property: "MAEncoder", allowed: FADER_FUNCTIONS },
  ma_encoder_left: { property: "MAEncoderLeft", allowed: SEQUENCE_BUTTON_FUNCTIONS },
  ma_encoder_right: { property: "MAEncoderRight", allowed: SEQUENCE_BUTTON_FUNCTIONS },
} as const;
type FunctionKey = keyof typeof EXECUTOR_FUNCTIONS;
const FUNCTION_KEYS = Object.keys(EXECUTOR_FUNCTIONS) as FunctionKey[];
const ENCODER_MODES: Array<{ continuous: FunctionKey; left: FunctionKey; right: FunctionKey; property: string }> = [
  { continuous: "encoder", left: "encoder_left", right: "encoder_right", property: "Encoder" },
  { continuous: "ma_encoder", left: "ma_encoder_left", right: "ma_encoder_right", property: "MAEncoder" },
];
const MACRO_BUTTON_FUNCTIONS = ["Empty", "<<<", ">>>", "Call", "Go+", "Go-", "Off", "Pause"];
function allowedFunction(assignedClass: string, key: FunctionKey): readonly string[] {
  if (assignedClass === "Sequence") return EXECUTOR_FUNCTIONS[key].allowed;
  if (assignedClass === "Macro") return key === "fader" || key === "encoder" || key === "ma_encoder" ? ["Empty"] : MACRO_BUTTON_FUNCTIONS;
  return [];
}

type CustomCommandKey = "key_press" | "key_unpress" | "ma_key_press" | "ma_key_unpress" | "encoder_left" | "encoder_right" | "ma_encoder_left" | "ma_encoder_right";
const CUSTOM_COMMAND_KEYS: CustomCommandKey[] = ["key_press", "key_unpress", "ma_key_press", "ma_key_unpress", "encoder_left", "encoder_right", "ma_encoder_left", "ma_encoder_right"];
const CUSTOM_COMMAND_PREFIXES: Record<CustomCommandKey, string> = {
  key_press: "Key", key_unpress: "KeyUnpress", ma_key_press: "MAKey", ma_key_unpress: "MAKeyUnpress",
  encoder_left: "EncoderLeft", encoder_right: "EncoderRight", ma_encoder_left: "MAEncoderLeft", ma_encoder_right: "MAEncoderRight",
};
const customCommandSchema = z.object({ command: z.string().optional(), enabled: z.boolean().optional(), add_executor: z.boolean().optional() }).strict();
const customCommandsSchema = z.object({
  key_press: customCommandSchema.optional(), key_unpress: customCommandSchema.optional(), ma_key_press: customCommandSchema.optional(), ma_key_unpress: customCommandSchema.optional(),
  encoder_left: customCommandSchema.optional(), encoder_right: customCommandSchema.optional(), ma_encoder_left: customCommandSchema.optional(), ma_encoder_right: customCommandSchema.optional(),
}).strict();
const CUSTOM_COMMAND_FIELDS = CUSTOM_COMMAND_KEYS.flatMap((key) => ["Command", "UseCustomCommand", "AddExecutor"].map((suffix) => `${CUSTOM_COMMAND_PREFIXES[key]}${suffix}`));

function customCommandValues(raw: unknown): Array<{ key: string; property: string; value: string; exact: boolean }> {
  if (raw === undefined) return [];
  const parsed = customCommandsSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`custom_commands: ${parsed.error.message}`, "custom_commands");
  const out: Array<{ key: string; property: string; value: string; exact: boolean }> = [];
  for (const key of CUSTOM_COMMAND_KEYS) {
    const spec = parsed.data[key];
    if (spec === undefined) continue;
    if (Object.keys(spec).length === 0) throw new ValidationError(`custom_commands.${key} needs command, enabled or add_executor`, "custom_commands");
    const prefix = CUSTOM_COMMAND_PREFIXES[key];
    if (spec.command !== undefined) {
      if (spec.enabled === undefined) throw new ValidationError(`custom_commands.${key}.command requires an explicit enabled flag because the console automatically enables new command text`, "custom_commands");
      const value = commandText(`custom_commands.${key}.command`, spec.command);
      if (/[\x00-\x1f\x7f]/.test(value)) throw new ValidationError(`custom_commands.${key}.command must not contain control characters`, "custom_commands");
      if (value.trim() !== value) throw new ValidationError(`custom_commands.${key}.command must not have leading or trailing whitespace because object read-back trims it`, "custom_commands");
      out.push({ key: `custom_commands.${key}.command`, property: `${prefix}Command`, value, exact: true });
    }
    if (spec.add_executor !== undefined) out.push({ key: `custom_commands.${key}.add_executor`, property: `${prefix}AddExecutor`, value: spec.add_executor ? "Yes" : "No", exact: false });
    if (spec.enabled !== undefined) out.push({ key: `custom_commands.${key}.enabled`, property: `${prefix}UseCustomCommand`, value: spec.enabled ? "Yes" : "No", exact: false });
  }
  return out;
}

/** Executor sizes extend right and toward higher numbered rows. Xkeys remain one cell. */
export function executorFootprint(executor: number, width: number, height: number): number[] {
  executorNumber("executor", executor);
  if (!Number.isInteger(width) || width < 1 || width > 5 || !Number.isInteger(height) || height < 1 || height > 4) throw new ValidationError("executor width must be 1-5 and height 1-4");
  const row = Math.floor(executor / 100);
  const column = executor % 100;
  if (column > 90 && (width !== 1 || height !== 1)) throw new ValidationError("Xkeys cannot be expanded by this tool");
  if (row + height > 5 || column + width > 91 && column <= 90) throw new ValidationError("the executor size extends beyond row 4 or column 90");
  const cells: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push(executor + y * 100 + x);
  return cells;
}

const emptyFieldErrors = z.record(z.string(), z.unknown()).refine((fields) => Object.keys(fields).length === 0, "field read errors are not a complete observation");
const referenceItemSchema = z.object({ invalid: z.literal(false).optional(), fieldErrors: emptyFieldErrors.optional(), class: z.string().optional(), name: z.string().optional(), addr: z.string().optional(), index: z.number().optional(), fields: z.record(z.string(), z.unknown()).optional() });
const referenceListingSchema = z.object({ total: z.number().int().nonnegative().optional(), items: z.array(referenceItemSchema), enumerationError: z.never().optional() });
const completeListingSchema = z.object({
  total: z.number().int().nonnegative(),
  enumerationError: z.never().optional(), offset: z.literal(0).optional(), count: z.number().int().nonnegative().optional(),
  items: z.array(referenceItemSchema),
}).refine((listing) => listing.total === listing.items.length && (listing.count === undefined || listing.count === listing.items.length), "the listing is truncated or its counts disagree");
const footprintListingSchema = z.object({
  total: z.number().int().nonnegative(),
  enumerationError: z.never().optional(), offset: z.literal(0).optional(), count: z.number().int().nonnegative().optional(),
  items: z.array(z.object({ invalid: z.literal(false).optional(), fieldErrors: emptyFieldErrors.optional(), class: z.enum(["Executor", "Proxy"]), fields: z.object({ No: z.union([z.number(), z.string()]), Width: z.union([z.number(), z.string()]).optional(), Height: z.union([z.number(), z.string()]).optional() }) })),
});

async function checkExecutorSize(ctx: ToolContext, page: number, executor: number, fromWidth: number, fromHeight: number, width: number, height: number): Promise<StepResult> {
  const name = "check_size";
  try {
    const covered = executorFootprint(executor, width, height);
    const owned = new Set(executorFootprint(executor, fromWidth, fromHeight));
    const raw = await ctx.bridge.request("children", { ref: `Page ${page}`, fields: ["No", "Width", "Height"], asText: false, limit: 500 }, ctx.requestTimeoutMs);
    const listing = footprintListingSchema.safeParse(raw);
    if (!listing.success) return asRead({ name, status: "failed", op: "children", error: "the page occupancy could not be read completely; no resize was sent" });
    if (listing.data.total !== listing.data.items.length || listing.data.count !== undefined && listing.data.count !== listing.data.items.length) return asRead({ name, status: "failed", op: "children", error: "the page occupancy scan was truncated or its counts disagree; no resize was sent" });
    const conflicts = new Set<number>();
    for (const item of listing.data.items) {
      const no = leadingInt(item.fields.No);
      if (no === undefined || !Number.isInteger(no)) throw new ValidationError("an executor number could not be read during the occupancy scan");
      if (no === executor || item.class === "Proxy" && owned.has(no)) continue;
      let cells: number[];
      if (item.class === "Proxy") cells = [no];
      else {
        const w = leadingInt(item.fields.Width);
        const h = leadingInt(item.fields.Height);
        if (w === undefined || h === undefined) throw new ValidationError(`the size of Page ${page}.${no} could not be read`);
        cells = executorFootprint(no, w, h);
      }
      for (const cell of cells) if (covered.includes(cell)) conflicts.add(cell);
    }
    if (conflicts.size) return asRead({ name, status: "failed", op: "children", detail: { covered, conflicts: [...conflicts] }, error: `the requested executor size overlaps occupied cells: ${[...conflicts].map((cell) => `Page ${page}.${cell}`).join(", ")}; no resize was sent` });
    return asRead({ name, status: "succeeded", op: "children", detail: { covered, width, height } });
  } catch (err) {
    return asRead(stepFromError(name, err, { op: "children" }));
  }
}

type SettingDef =
  | { property: string; kind: "bool" }
  | { property: string; kind: "enum"; values: Record<string, string> }
  /** A speed master by number (1-16) or "none"; written as the master's name, which is resolved per call. */
  | { property: string; kind: "master" };

/** Enums.SpeedScale on 2.5.1, keyed by lower case. */
const SCALE_VALUES: Record<string, string> = Object.fromEntries(
  [...[256, 128, 64, 32, 16, 8, 4, 2].map((d) => `Div${d}`), "One", ...[2, 4, 8, 16, 32, 64, 128, 256].map((m) => `Mul${m}`)].map((n) => [n.toLowerCase(), n]),
);
const MASTER_TOKEN = "#master:";

/** Sequence parameters -> property names and their console values (enum names as on 2.5.1). */
export const SEQUENCE_SETTINGS: Record<string, SettingDef> = {
  wrap_around: { property: "WrapAround", kind: "bool" },
  priority: {
    property: "Priority",
    kind: "enum",
    values: { super: "Super", swap: "Swap", htp: "HTP", highest: "Highest", high: "High", ltp: "LTP", low: "Low", lowest: "Lowest" },
  },
  restart_mode: { property: "RestartMode", kind: "enum", values: { first_cue: "First Cue", current_cue: "Current Cue", next_cue: "Next Cue" } },
  release_first_cue: { property: "ReleaseFirstCue", kind: "bool" },
  auto_start: { property: "AutoStart", kind: "bool" },
  auto_stop: { property: "AutoStop", kind: "bool" },
  master_go_mode: { property: "MasterGoMode", kind: "enum", values: { none: "None", go: "Go", on: "On", top: "Top" } },
  auto_fix: { property: "AutoFix", kind: "bool" },
  auto_stomp: { property: "AutoStomp", kind: "bool" },
  tracking: { property: "Tracking", kind: "bool" },
  soft_ltp: { property: "SoftLTP", kind: "bool" },
  off_when_overridden: { property: "OffWhenOverridden", kind: "bool" },
  kill_protect: { property: "KillProtect", kind: "bool" },
  swap_protect: { property: "SwapProtect", kind: "bool" },
  use_executor_time: { property: "UseExecutorTime", kind: "bool" },
  include_link_last_go: { property: "IncludeLinkLastGo", kind: "bool" },
  xfade_mode: { property: "XFadeMode", kind: "enum", values: { ab: "AB", split: "Split" } },
  xfade_reload: { property: "XFadeReload", kind: "bool" },
  speed_master: { property: "SpeedMaster", kind: "master" },
  rate_master: { property: "RateMaster", kind: "master" },
  speed_scale: { property: "SpeedScale", kind: "enum", values: SCALE_VALUES },
  rate_scale: { property: "RateScale", kind: "enum", values: SCALE_VALUES },
  speed_from_rate: { property: "SpeedFromRate", kind: "bool" },
};
const SETTING_KEYS = Object.keys(SEQUENCE_SETTINGS);

const EXECUTOR_READ_FIELDS = [...FUNCTION_KEYS.map((k) => EXECUTOR_FUNCTIONS[k].property), ...CUSTOM_COMMAND_FIELDS, "Width", "Height", "ExecutorConfiguration", "Fix", "Lock", "StructureLocked", "SystemLocked"];
const SEQUENCE_READ_FIELDS = ["Name", ...SETTING_KEYS.map((k) => SEQUENCE_SETTINGS[k].property), "Lock", "StructureLocked", "SystemLocked"];
/** Walking more pages than this for references is reported as incomplete. */
const MAX_REFERENCE_PAGES = 200;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A function name from `allowed`, matched case-insensitively and returned in the console's spelling. */
export function functionName(field: string, value: unknown, allowed: readonly string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string (one of ${allowed.join(", ")})`, field);
  const hit = allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  if (!hit) throw new ValidationError(`${field} must be one of ${allowed.join(", ")} for a sequence executor (got ${JSON.stringify(value)})`, field);
  return hit;
}

export function settingValue(field: string, def: SettingDef, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (def.kind === "bool") {
    if (typeof value !== "boolean") throw new ValidationError(`${field} must be true or false`, field);
    return value ? "Yes" : "No";
  }
  if (def.kind === "master") {
    if (typeof value === "string" && value.trim().toLowerCase() === "none") return "None";
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16) throw new ValidationError(`${field} must be a speed master number 1-16 or "none" (got ${JSON.stringify(value)})`, field);
    return `${MASTER_TOKEN}${value}`;
  }
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  const hit = def.values[key];
  if (!hit) throw new ValidationError(`${field} must be one of ${Object.keys(def.values).join(", ")} (got ${JSON.stringify(value)})`, field);
  return hit;
}

function optionalBool(field: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be true or false`, field);
  return value;
}

// ---------------------------------------------------------------------------
// Console readers
// ---------------------------------------------------------------------------

/**
 * The lock state of a Lock display value ("UL" on 2.5.1 when locked; "" or "No" when not), or null when the value is
 * missing: a property the bridge could not read is absent from the reply and is never taken as "unlocked".
 */
export function lockState(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  return !(s === "" || s === "no" || s === "off" || s === "false");
}
/** Yes/No display value as a boolean, or null when missing or not a Yes/No word. */
const yesNo = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "yes" ? true : s === "no" ? false : null;
};
const isYes = (v: unknown) => yesNo(v) === true;
const displayOf = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const isMissing = (v: unknown) => v === null || v === undefined;
/** The fields of `names` that a read did not return. */
const missingFields = (fields: Record<string, unknown>, names: string[]) => names.filter((n) => isMissing(fields[n]));

export interface AssignedRef {
  class?: string;
  index?: number;
  name?: string;
  addr?: string;
}

function toAssigned(value: unknown): AssignedRef | null {
  if (!value || typeof value !== "object") return null;
  const parsed = z.object({ class: z.string().optional(), index: z.number().optional(), name: z.string().optional(), addr: z.string().optional() }).safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  const out: AssignedRef = {};
  if (typeof v.class === "string") out.class = v.class;
  if (typeof v.index === "number") out.index = v.index;
  if (typeof v.name === "string") out.name = v.name;
  if (typeof v.addr === "string") out.addr = v.addr;
  return Object.keys(out).length ? out : null;
}

/** One `objects` read as a read-only step; `interpret` gets the first item or null when nothing matched. */
async function objectsRead(bridge: Gma3Bridge, name: string, ref: string, fields: string[], asText: boolean, interpret: (item: ObjectSummary | null) => StepResult): Promise<StepResult> {
  try {
    const res = await readObjects(bridge, ref, fields, 1, { asText });
    const item = res?.items?.[0];
    if (item?.fieldErrors !== undefined && !emptyFieldErrors.safeParse(item.fieldErrors).success) return asRead({ name, status: "failed", op: "objects", error: `requested fields of ${ref} could not be read without errors`, detail: item.fieldErrors });
    return asRead(interpret(!item || item.invalid ? null : item));
  } catch (err) {
    return asRead(stepFromError(name, err, { op: "objects", detail: { ref, fields } }));
  }
}

/** HasActivePlayback of an object through the `object` op (properties not read). null when unavailable. */
async function playbackActive(bridge: Gma3Bridge, ref: string, timeoutMs: number): Promise<boolean | null> {
  try {
    const res = (await bridge.request("object", { ref, properties: false }, timeoutMs)) as { hasActivePlayback?: unknown };
    return typeof res?.hasActivePlayback === "boolean" ? res.hasActivePlayback : null;
  } catch {
    return null;
  }
}

export interface ExecutorReference {
  data_pool?: number;
  page: number;
  executor: number;
  ref: string;
  /** Address of the assigned object. */
  addr?: string;
}

export interface References {
  complete: boolean;
  executors: ExecutorReference[];
  pagesScanned: number;
  requests: number;
  error?: string;
}

function leadingInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = typeof v === "string" ? v.match(/^\s*(\d+)/) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Every executor in the current data pool whose assigned object has address `addr`: one `children` read of
 * DataPool.Pages and one per page. Never throws; an incomplete scan says why.
 */
export async function findReferences(bridge: Gma3Bridge, addr: string, timeoutMs: number): Promise<References> {
  return findReferencesWhere(bridge, (a) => a === addr, timeoutMs);
}

/** Every executor in the current data pool whose assigned object's address satisfies `match`. Never throws. */
export async function findReferencesWhere(bridge: Gma3Bridge, match: (addr: string) => boolean, timeoutMs: number, property = "Object", pagesRef = "DataPool.Pages"): Promise<References> {
  const out: References = { complete: false, executors: [], pagesScanned: 0, requests: 0 };
  let unreadable = false;
  try {
    out.requests++;
    const pageResult = (property === "ExecutorConfiguration" ? completeListingSchema : referenceListingSchema).safeParse(await bridge.request("children", { ref: pagesRef, fields: ["No"], asText: false, limit: MAX_REFERENCE_PAGES }, timeoutMs));
    if (!pageResult.success) throw new Error("the complete page listing could not be read");
    const pages = pageResult.data;
    const items = pages?.items ?? [];
    for (const pg of items) {
      if (!pg.addr) { unreadable = true; continue; }
      out.requests++;
      const executorResult = (property === "ExecutorConfiguration" ? completeListingSchema : referenceListingSchema).safeParse(await bridge.request("children", { ref: pg.addr, fields: ["No", property], asText: false, limit: 10000 }, timeoutMs));
      if (!executorResult.success) throw new Error(`the complete executor listing of ${pg.addr} could not be read`);
      const execs = executorResult.data;
      out.pagesScanned++;
      const pageNo = leadingInt(pg.fields?.No) ?? pg.index;
      if (pageNo === undefined || (execs.total ?? 0) > (execs.items?.length ?? 0)) unreadable = true;
      for (const x of execs?.items ?? []) {
        const obj = toAssigned(x.fields?.[property]);
        const execNo = leadingInt(x.fields?.No);
        if (property === "ExecutorConfiguration" && x.class !== "Proxy" && (x.class !== "Executor" || execNo === undefined || x.fields?.[property] !== "" && x.fields?.[property] !== null && !obj?.addr)) unreadable = true;
        if (obj?.addr && match(obj.addr) && pageNo !== undefined && execNo !== undefined) out.executors.push({ page: pageNo, executor: execNo, ref: executorRef(pageNo, execNo), addr: obj.addr });
      }
    }
    const total = pages?.total ?? items.length;
    out.complete = total <= items.length && !unreadable;
    if (!out.complete) out.error = unreadable ? "a page, executor listing or requested reference field could not be read completely" : `only the first ${items.length} of ${total} pages were scanned`;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

function referenceWarning(label: string, refs: References, self?: string): string | undefined {
  // Without an executor of its own (gma3_configure_sequence) a single referencing executor is no sharing.
  const others = refs.executors.filter((r) => r.ref !== self);
  const incomplete = refs.complete ? "" : ` (the page scan was incomplete: ${refs.error ?? "unknown reason"})`;
  if (others.length === 0 || (self === undefined && others.length === 1 && refs.complete)) {
    return refs.complete ? undefined : `executors sharing ${label} could not all be determined${incomplete}`;
  }
  return `sequence settings belong to ${label}, so they also apply to ${others.map((r) => r.ref).join(", ")}${incomplete}`;
}

// ---------------------------------------------------------------------------
// Shared mutation machinery
// ---------------------------------------------------------------------------

interface Change {
  /** Tool parameter name, or "lock" / "unlock_page" / ... for lock handling. */
  key: string;
  ref: string;
  property: string;
  from: string;
  to: string;
  exact?: boolean;
}

/**
 * One `set` request. The bridge answers with the value read back in the edit role; because the console silently
 * keeps the old value for anything it does not accept, a reply that differs from `expect` fails the step.
 */
function setStep(ctx: ToolContext, name: string, ref: string, property: string, value: string, expect: (v: unknown) => boolean): () => Promise<StepResult> {
  return () =>
    requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
      const parsed = z.object({ value: z.unknown().optional(), exact: z.string().optional(), readOk: z.boolean().optional() }).safeParse(res);
      const got = parsed.success && parsed.data.readOk !== false ? parsed.data.exact ?? parsed.data.value : undefined;
      if (isMissing(got)) {
        // Sent, but the reply carries no read-back value: whether the console applied it is unknown.
        return { name, status: "unknown", op: "set", detail: { ref, property, sent: value }, error: `${property} of ${ref} could not be read back after the write; whether the console applied ${JSON.stringify(value)} is unknown` };
      }
      if (!expect(got)) {
        return { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got ?? null }, error: `the console did not apply ${property}=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got ?? null)} (the console silently keeps the previous value when it does not accept one)` };
      }
      return { name, status: "succeeded", op: "set", detail: { ref, property, value: got } };
    }, ctx.requestTimeoutMs);
}

const sameDisplay = (want: string) => (got: unknown) => displayOf(got).toLowerCase() === (want === "Empty" ? "" : want).toLowerCase();
const lockedIs = (want: boolean) => (got: unknown) => lockState(got) === want;

interface LockOwner {
  /** "page", "executor" or "sequence". */
  owner: string;
  ref: string;
  locked: boolean;
}

interface MutationPlan {
  unlocks: LockOwner[];
  changes: Change[];
  /** Locks to restore after the changes (the owners unlocked for this call), and an explicit final lock. */
  relocks: LockOwner[];
  finalLock?: { ref: string; locked: boolean };
}

/**
 * Run unlock -> changes (-> explicit lock) in order, stopping at the first step that is not a confirmed success,
 * then restore every lock this call removed, even after a failure (restoring protection is never skipped once it
 * was removed). Returns all steps in order.
 */
async function executePlan(ctx: ToolContext, plan: MutationPlan): Promise<{ steps: StepResult[]; relockFailed: string[] }> {
  const main: Array<{ name: string; run: () => Promise<StepResult> }> = [];
  for (const u of plan.unlocks) main.push({ name: `unlock_${u.owner}`, run: setStep(ctx, `unlock_${u.owner}`, u.ref, "Lock", "No", lockedIs(false)) });
  for (const c of plan.changes) main.push({ name: `set_${c.key}`, run: setStep(ctx, `set_${c.key}`, c.ref, c.property, c.to, c.exact ? (got) => got === c.to : sameDisplay(c.to)) });
  if (plan.finalLock) {
    const fl = plan.finalLock;
    main.push({ name: fl.locked ? "lock" : "unlock", run: setStep(ctx, fl.locked ? "lock" : "unlock", fl.ref, "Lock", fl.locked ? "Yes" : "No", lockedIs(fl.locked)) });
  }
  const { steps } = await runSteps(main);
  const relockFailed: string[] = [];
  for (const r of plan.relocks) {
    const unlockStep = steps.find((s) => s.name === `unlock_${r.owner}`);
    // Restore only what this call may have unlocked: a confirmed unlock, or one whose reply was lost.
    if (!unlockStep || (unlockStep.status !== "succeeded" && unlockStep.status !== "unknown")) continue;
    const name = `relock_${r.owner}`;
    const s = await setStep(ctx, name, r.ref, "Lock", "Yes", lockedIs(true))();
    steps.push(s);
    if (s.status !== "succeeded") relockFailed.push(r.ref);
  }
  return { steps, relockFailed };
}

function skippedSteps(names: string[], why: string): StepResult[] {
  return names.map((name) => ({ name, status: "skipped" as const, error: `not attempted: ${why}` }));
}

function plannedStepNames(plan: MutationPlan): string[] {
  return [
    ...plan.unlocks.map((u) => `unlock_${u.owner}`),
    ...plan.changes.map((c) => `set_${c.key}`),
    ...(plan.finalLock ? [plan.finalLock.locked ? "lock" : "unlock"] : []),
    ...plan.relocks.map((r) => `relock_${r.owner}`),
  ];
}

/** Read-back of the touched properties of one object, compared with the requested values. */
async function readBackObject(bridge: Gma3Bridge, ref: string, expected: Record<string, string>, lockExpected: boolean | undefined, exactFields: string[] = []): Promise<{ step: StepResult; verification: Verification; values: Record<string, unknown> | null }> {
  const fields = [...Object.keys(expected), ...(lockExpected !== undefined ? ["Lock"] : [])];
  let values: Record<string, unknown> | null = null;
  const step = await objectsRead(bridge, `read_back`, ref, fields, true, (item) => {
    if (!item) return { name: "read_back", status: "failed", op: "objects", error: `${ref} could not be read back` };
    values = item.fields ?? {};
    return { name: "read_back", status: "succeeded", op: "objects", detail: { ref, values } };
  });
  if (step.status !== "succeeded" || !values) return { step, verification: unavailable(step.error ?? "read-back failed", ref), values };
  const want: Record<string, unknown> = {};
  for (const [p, v] of Object.entries(expected)) want[p] = v === "Empty" && !exactFields.includes(p) ? "" : v;
  if (lockExpected !== undefined) want.Lock = lockExpected;
  const verification = compareFields(`${Object.keys(want).join(", ")} of ${ref}`, want, values, { normalize: { Lock: (v) => lockState(v) } });
  const exactMismatches = exactFields.filter((field) => values?.[field] !== expected[field]).map((field) => `${field}: expected exact text ${JSON.stringify(expected[field])}, read ${JSON.stringify(values?.[field] ?? null)}`);
  if (exactMismatches.length) {
    verification.status = "mismatched";
    verification.detail = [verification.detail, ...exactMismatches].filter(Boolean).join("; ");
  }
  return { step, verification, values };
}

/**
 * Where an assigned sequence lives. An executor can hold a sequence from another data pool (manual: data pools), so
 * the sequence is always read by its address; `ref` (`Sequence <n>`) is given only when it is in the current data
 * pool, where gma3_configure_sequence can address it by number.
 */
async function sequenceLocation(bridge: Gma3Bridge, assigned: AssignedRef, timeoutMs: number): Promise<{ ref: string | null; dataPool: "current" | "other" | "unknown"; label: string; note?: string }> {
  let pool: string | undefined;
  try {
    const poolNumber = dataPoolOf(bridge);
    const result = z.object({ addr: z.string().optional() }).safeParse(await bridge.request("object", { ref: poolNumber === undefined ? "DataPool" : `DataPool ${poolNumber}`, properties: false }, timeoutMs));
    pool = result.success ? result.data.addr : undefined;
  } catch {
    pool = undefined;
  }
  const addr = assigned.addr ?? "";
  const label = assigned.index !== undefined ? `Sequence ${assigned.index}${assigned.name ? ` "${assigned.name}"` : ""}` : `the sequence at ${addr}`;
  if (!pool) return { ref: null, dataPool: "unknown", label, note: "the current data pool could not be read; the sequence was read by its address" };
  if (addr.startsWith(`${pool}.`) && assigned.index !== undefined) return { ref: `Sequence ${assigned.index}`, dataPool: "current", label: `Sequence ${assigned.index}` };
  return { ref: null, dataPool: "other", label: `${label} (address ${addr}, another data pool)`, note: `the executor holds a sequence from another data pool (address ${addr}); it was read by address, and gma3_configure_sequence (current data pool, by number) cannot address it` };
}

// ---------------------------------------------------------------------------
// gma3_executor_settings (read-only)
// ---------------------------------------------------------------------------

/** Function names as read ("Empty" for an empty function), null for a property that could not be read. */
function readFunctions(fields: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of FUNCTION_KEYS) {
    const v = fields[EXECUTOR_FUNCTIONS[k].property];
    out[k] = isMissing(v) ? null : displayOf(v) || "Empty";
  }
  return out;
}

function readSettings(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    const def = SEQUENCE_SETTINGS[k];
    const raw = displayOf(fields[def.property]);
    if (def.kind === "bool") out[k] = yesNo(raw);
    else if (def.kind === "master") out[k] = !raw || raw.toLowerCase() === "none" ? null : raw;
    else out[k] = Object.entries(def.values).find(([, v]) => v.toLowerCase() === raw.toLowerCase())?.[0] ?? (raw || null);
  }
  return out;
}

const allowedFor = (assignedClass = "Sequence") => Object.fromEntries(FUNCTION_KEYS.map((k) => [k, [...allowedFunction(assignedClass, k)]]));

function readCustomCommands(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CUSTOM_COMMAND_KEYS.map((key) => {
    const prefix = CUSTOM_COMMAND_PREFIXES[key];
    return [key, { command: fields[`${prefix}Command`] ?? null, enabled: yesNo(fields[`${prefix}UseCustomCommand`]), add_executor: yesNo(fields[`${prefix}AddExecutor`]) }];
  }));
}

export async function executorSettings(ctx: ToolContext, raw: { page: number; executor: number; references?: boolean }): Promise<unknown> {
  const v = new Validator();
  const page = v.check(() => pageNumber("page", raw.page));
  const executor = v.check(() => executorNumber("executor", raw.executor));
  if (!v.ok || page === undefined || executor === undefined) throw new ValidationError(v.errors.join("; "));
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const ref = executorRef(page, executor);

  const pageFields = await readObjects(bridge, `Page ${page}`, ["Lock"], 1);
  const pageItem = pageFields?.items?.[0];
  if (!pageItem) return { page, executor, ref, pageExists: false, empty: true, note: `Page ${page} does not exist` };
  const objRes = await readObjects(bridge, ref, ["Object"], 1, { asText: false });
  const assigned = toAssigned(objRes?.items?.[0]?.fields?.Object);
  // null = the value could not be read (never reported as unlocked).
  const pageInfo = { exists: true, locked: lockState(pageItem.fields?.Lock) };
  if (!assigned) return { page, executor, ref, pageInfo, empty: true, note: `${ref} is empty: nothing is assigned` };

  const exec = (await readObjects(bridge, ref, EXECUTOR_READ_FIELDS, 1))?.items?.[0]?.fields ?? {};
  const out: Record<string, unknown> = {
    page,
    executor,
    ref,
    empty: false,
    pageInfo,
    executorSettings: { functions: readFunctions(exec), custom_commands: readCustomCommands(exec), width: leadingInt(exec.Width) ?? null, height: leadingInt(exec.Height) ?? null, configuration: exec.ExecutorConfiguration ?? null, fix: yesNo(exec.Fix), locked: lockState(exec.Lock), structureLocked: yesNo(exec.StructureLocked), systemLocked: yesNo(exec.SystemLocked) },
    assigned,
    protection: {
      page: { property: "Lock", locked: pageInfo.locked, protects: "every executor on the page from configuration changes and new assignments" },
      executor: { property: "Lock", locked: lockState(exec.Lock), protects: "this executor's functions and assignment" },
    },
  };
  const unread = missingFields(exec, EXECUTOR_READ_FIELDS);
  if (unread.length) out.unreadable = unread;
  if (assigned.class === "Sequence" || assigned.class === "Macro") out.allowedFunctions = allowedFor(assigned.class);
  if (assigned.class !== "Sequence" || !assigned.addr) {
    out.note = `${ref} holds a ${assigned.class ?? "non-sequence"} object; sequence playback settings do not apply`;
    return out;
  }
  // Read the sequence the executor actually holds, by address: it may come from another data pool.
  const where = await sequenceLocation(bridge, assigned, t);
  const seq = (await readObjects(bridge, assigned.addr, SEQUENCE_READ_FIELDS, 1))?.items?.[0]?.fields ?? {};
  out.sequence = {
    ref: where.ref,
    addr: assigned.addr,
    dataPool: where.dataPool,
    name: seq.Name ?? assigned.name,
    settings: readSettings(seq),
    locked: lockState(seq.Lock),
    structureLocked: yesNo(seq.StructureLocked),
    systemLocked: yesNo(seq.SystemLocked),
    active: await playbackActive(bridge, assigned.addr, t),
    ...(where.note ? { note: where.note } : {}),
  };
  (out.protection as Record<string, unknown>).sequence = {
    property: "Lock",
    locked: lockState(seq.Lock),
    protects: "the sequence's settings and cues (Store answers \"Cannot Create Object\"); not protected by a page or executor lock",
    killProtect: yesNo(seq.KillProtect),
    swapProtect: yesNo(seq.SwapProtect),
    note: "Kill Protect and Swap Protect protect playback from the Kill and Swap actions, not from editing",
  };
  if (raw.references !== false) {
    const refs = await findReferences(bridge, assigned.addr, t);
    out.references = refs;
    const w = referenceWarning(where.label, refs, ref);
    if (w) out.warnings = [w];
  }
  return out;
}

// ---------------------------------------------------------------------------
// gma3_configure_executor
// ---------------------------------------------------------------------------

interface ConfigureExecutorArgs extends Partial<Record<FunctionKey, string>> {
  page: number;
  executor: number;
  key_press?: string;
  key_unpress?: string;
  ma_key_press?: string;
  ma_key_unpress?: string;
  fader?: string;
  encoder?: string;
  encoder_left?: string;
  encoder_right?: string;
  custom_commands?: unknown;
  width?: number;
  height?: number;
  fix?: boolean;
  lock?: boolean;
  unlock?: boolean;
  preview?: boolean;
  verify?: boolean;
}

export async function configureExecutor(ctx: ToolContext, raw: ConfigureExecutorArgs): Promise<OperationResult> {
  const op = "configure_executor";
  const v = new Validator();
  const page = v.check(() => pageNumber("page", raw.page));
  const executor = v.check(() => executorNumber("executor", raw.executor));
  const wanted: Partial<Record<FunctionKey, string>> = {};
  for (const k of FUNCTION_KEYS) {
    const val = v.check(() => functionName(k, raw[k], [...EXECUTOR_FUNCTIONS[k].allowed, ...allowedFunction("Macro", k)]));
    if (val !== undefined) wanted[k] = val;
  }
  const fix = v.check(() => optionalBool("fix", raw.fix));
  const custom = v.check(() => customCommandValues(raw.custom_commands)) ?? [];
  const modeClears: Record<string, string> = {};
  const disabledCommandModes: string[] = [];
  const functionCustomFlags = CUSTOM_COMMAND_KEYS.filter((key) => wanted[key] !== undefined).map((key) => ({ key, property: `${CUSTOM_COMMAND_PREFIXES[key]}UseCustomCommand` }));
  for (const mode of ENCODER_MODES) {
    const customDiscrete = custom.some((change) => [`${mode.property}LeftUseCustomCommand`, `${mode.property}RightUseCustomCommand`].includes(change.property) && change.value === "Yes");
    const continuous = wanted[mode.continuous] !== undefined && wanted[mode.continuous] !== "Empty";
    const discrete = customDiscrete || [wanted[mode.left], wanted[mode.right]].some((value) => value !== undefined && value !== "Empty");
    if (continuous && discrete) v.errors.push(`${mode.continuous} and ${mode.left}/${mode.right} functions or enabled custom commands use mutually exclusive continuous/discrete modes; request only one non-Empty mode per call`);
    if (continuous) {
      modeClears[`${mode.property}Left`] = "Empty";
      modeClears[`${mode.property}Right`] = "Empty";
      modeClears[`${mode.property}LeftUseCustomCommand`] = "No";
      modeClears[`${mode.property}RightUseCustomCommand`] = "No";
    } else if (discrete) modeClears[mode.property] = "Empty";
    const disabledCommand = custom.some((change) => [`${mode.property}LeftCommand`, `${mode.property}RightCommand`].includes(change.property) && custom.some((flag) => flag.property === change.property.replace(/Command$/, "UseCustomCommand") && flag.value === "No"));
    if (disabledCommand && continuous) v.errors.push(`disabled ${mode.continuous} custom command text cannot be stored alongside a continuous function; its text setter would clear that mode`);
    if (disabledCommand && wanted[mode.continuous] !== "Empty") disabledCommandModes.push(mode.property);
  }
  const width = raw.width === undefined ? undefined : v.check(() => finiteNumber("width", raw.width, { integer: true, min: 1, max: 5 }));
  const height = raw.height === undefined ? undefined : v.check(() => finiteNumber("height", raw.height, { integer: true, min: 1, max: 4 }));
  const lock = v.check(() => optionalBool("lock", raw.lock));
  const unlock = raw.unlock === true;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { page: raw.page, executor: raw.executor };
  if (dataPoolOf(ctx.bridge) !== undefined) target.data_pool = dataPoolOf(ctx.bridge);
  if (v.ok && Object.keys(wanted).length === 0 && custom.length === 0 && width === undefined && height === undefined && fix === undefined && lock === undefined) v.errors.push("nothing to configure: give at least one function, custom command, size, fix or lock");
  if (!v.ok || page === undefined || executor === undefined) return validationFailure(op, target, v.errors);
  const ref = executorRef(page, executor);
  target.executorRef = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  const body = async (): Promise<OperationResult> => {
    let pageLocked = false;
    let assigned: AssignedRef | null = null;
    let current: Record<string, unknown> = {};
    const inspect = await runSteps([
      {
        name: "check_page",
        run: () =>
          objectsRead(bridge, "check_page", `Page ${page}`, ["Lock"], true, (item) => {
            if (!item) return { name: "check_page", status: "failed", op: "objects", error: `Page ${page} does not exist` };
            const state = lockState(item.fields?.Lock);
            if (state === null) return { name: "check_page", status: "failed", op: "objects", error: `the Lock of Page ${page} could not be read; nothing was sent because a locked page silently ignores changes` };
            pageLocked = state;
            return { name: "check_page", status: "succeeded", op: "objects", detail: { locked: pageLocked } };
          }),
      },
      {
        name: "inspect_executor",
        run: () =>
          objectsRead(bridge, "inspect_executor", ref, ["Object"], false, (item) => {
            assigned = toAssigned(item?.fields?.Object);
            if (!assigned) return { name: "inspect_executor", status: "failed", op: "objects", error: `${ref} is empty: nothing is assigned, so there is nothing to configure (assign a sequence first)` };
            if ((assigned.class !== "Sequence" && assigned.class !== "Macro") || !assigned.addr) {
              return { name: "inspect_executor", status: "failed", op: "objects", detail: { assigned }, error: `${ref} holds a ${assigned.class ?? "unsupported"} object; only Sequence and Macro executors are configurable, and the assigned address must be readable` };
            }
            for (const key of FUNCTION_KEYS) {
              const value = wanted[key];
              if (value !== undefined && !allowedFunction(assigned.class, key).includes(value)) return { name: "inspect_executor", status: "failed", op: "objects", detail: { assigned }, error: `${key}=${value} is not supported for a ${assigned.class} executor; allowed: ${allowedFunction(assigned.class, key).join(", ")}` };
            }
            return { name: "inspect_executor", status: "succeeded", op: "objects", detail: { assigned } };
          }),
      },
      {
        name: "read_executor",
        run: () =>
          objectsRead(bridge, "read_executor", ref, EXECUTOR_READ_FIELDS, true, (item) => {
            if (!item) return { name: "read_executor", status: "failed", op: "objects", error: `${ref} could not be read` };
            current = item.fields ?? {};
            // Every value the plan depends on must have been read: a missing one is unknown, never "Empty" or "unlocked".
            const needed = ["Lock", "StructureLocked", "SystemLocked", ...FUNCTION_KEYS.filter((key) => wanted[key] !== undefined).map((k) => EXECUTOR_FUNCTIONS[k].property), ...functionCustomFlags.map((flag) => flag.property), ...Object.keys(modeClears), ...disabledCommandModes, ...custom.map((change) => change.property), ...(width !== undefined || height !== undefined ? ["Width", "Height"] : []), ...(fix !== undefined ? ["Fix"] : [])];
            const unread = [...missingFields(current, needed), ...["StructureLocked", "SystemLocked", ...(fix !== undefined ? ["Fix"] : [])].filter((f) => !isMissing(current[f]) && yesNo(current[f]) === null)];
            if (unread.length) return { name: "read_executor", status: "failed", op: "objects", detail: { values: current }, error: `${unread.join(", ")} of ${ref} could not be read; nothing was sent because the current values are unknown` };
            for (const property of disabledCommandModes) if ((displayOf(current[property]) || "Empty") !== "Empty") return { name: "read_executor", status: "failed", op: "objects", error: `storing disabled ${property} command text would clear the existing continuous mode; clear that mode explicitly first` };
            return { name: "read_executor", status: "succeeded", op: "objects", detail: { functions: readFunctions(current), fix: displayOf(current.Fix), lock: displayOf(current.Lock) } };
          }),
      },
    ]);
    const a = assigned as AssignedRef | null;
    // Playback is watched on the sequence the executor holds, by address (it may belong to another data pool).
    const seqAddr = a?.class === "Sequence" ? a.addr : undefined;
    const seqLabel = a?.index !== undefined ? `${a.class} ${a.index}${seqAddr ? ` (${seqAddr})` : ""}` : seqAddr;
    const base = { previous: inspect.outcome === "succeeded" ? { functions: readFunctions(current), fix: yesNo(current.Fix), locked: lockState(current.Lock), pageLocked } : undefined, assigned: a };
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra: base });
    }
    if (width !== undefined || height !== undefined) {
      const oldWidth = leadingInt(current.Width);
      const oldHeight = leadingInt(current.Height);
      if (oldWidth === undefined || oldHeight === undefined) return validationFailure(op, target, ["the current executor size is unreadable"]);
      const size = await checkExecutorSize(ctx, page, executor, oldWidth, oldHeight, width ?? oldWidth, height ?? oldHeight);
      inspect.steps.push(size);
      if (size.status !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: `configure_executor refused: ${size.error}. Nothing was sent.`, extra: base });
    }

    // Plan: changed values only; unchanged ones are reported and not sent.
    const changes: Change[] = [];
    const unchanged: string[] = [];
    for (const k of Object.keys(wanted) as FunctionKey[]) {
      const prop = EXECUTOR_FUNCTIONS[k].property;
      const from = displayOf(current[prop]) || "Empty";
      if (from.toLowerCase() === wanted[k]!.toLowerCase()) unchanged.push(k);
      else changes.push({ key: k, ref, property: prop, from, to: wanted[k]! });
    }
    const commandFlags = new Set(custom.filter((change) => /Command$/.test(change.property) && !/UseCustomCommand$/.test(change.property)).map((change) => change.property.replace(/Command$/, "UseCustomCommand")));
    for (const change of custom) {
      const from = current[change.property];
      if (from === change.value && !commandFlags.has(change.property)) unchanged.push(change.key);
      else changes.push({ key: change.key, ref, property: change.property, from: displayOf(from), to: change.value, exact: change.exact });
    }
    const sizeChanges: Change[] = [];
    for (const [key, property, value] of [["width", "Width", width], ["height", "Height", height]]) {
      if (typeof key !== "string" || typeof property !== "string" || typeof value !== "number") continue;
      const from = displayOf(current[property]);
      if (Number(from) === value) unchanged.push(key);
      else sizeChanges.push({ key, ref, property, from, to: String(value) });
    }
    // Shrink first so an intermediate rectangle never reaches outside the checked final rectangle.
    sizeChanges.sort((a, b) => Number(a.to) - Number(a.from) - (Number(b.to) - Number(b.from)));
    changes.push(...sizeChanges);
    if (fix !== undefined) {
      const from = isYes(current.Fix);
      if (from === fix) unchanged.push("fix");
      else changes.push({ key: "fix", ref, property: "Fix", from: from ? "Yes" : "No", to: fix ? "Yes" : "No" });
    }
    const execLocked = lockState(current.Lock) === true;
    const hardLocked = isYes(current.StructureLocked) || isYes(current.SystemLocked);
    const lockChange = lock !== undefined && lock !== execLocked;
    if (lock !== undefined && !lockChange) unchanged.push("lock");

    const blockers: LockOwner[] = [];
    if (pageLocked && (changes.length || lockChange)) blockers.push({ owner: "page", ref: `Page ${page}`, locked: true });
    // An explicit lock: false on a locked executor is itself the requested unlock; any other change needs unlock: true.
    if (execLocked && changes.length && lock !== false) blockers.push({ owner: "executor", ref, locked: true });
    const plan: MutationPlan = {
      unlocks: unlock ? blockers : [],
      changes,
      // Reverse order: the executor is locked again before its page (a locked page blocks the executor's Lock write).
      relocks: unlock ? blockers.filter((b) => !(b.owner === "executor" && lock === false)).reverse() : [],
      finalLock: lockChange ? { ref, locked: lock! } : undefined,
    };
    if (execLocked && lock === false && changes.length) {
      // Unlock first so the changes can take effect, and do not relock. A locked page blocks the executor's own
      // Lock write too, so the page (when unlock: true) comes first.
      plan.unlocks = [...plan.unlocks.filter((u) => u.owner !== "executor"), { owner: "executor", ref, locked: true }];
      plan.finalLock = undefined;
    }
    const intended = {
      changes: changes.map(({ key, property, from, to }) => ({ key, property, from, to })),
      unchanged,
      ...(lockChange ? { lock: { from: execLocked, to: lock } } : {}),
      locks: { page: pageLocked, executor: execLocked },
      unlockAndRelock: plan.relocks.map((r) => r.ref),
      ...(Object.keys(modeClears).length ? { implicitModeClears: modeClears } : {}),
    };
    const extra = { ...base, sequence: seqLabel, sequenceAddr: seqAddr, intended };

    if (hardLocked) {
      const s: StepResult = { name: "check_locks", status: "failed", error: `${ref} is structure- or system-locked by the console; it cannot be configured` };
      return buildResult({ operation: op, target, steps: [...inspect.steps, s], verification: notRequested(), summary: `${op} refused: ${s.error}. Nothing was sent.`, extra });
    }
    if (blockers.length && !unlock) {
      const owners = blockers.map((b) => `${b.owner} (${b.ref})`).join(" and ");
      const s: StepResult = { name: "check_locks", status: "failed", error: `locked by the ${owners}; the console would silently ignore the changes. Pass unlock: true to unlock, apply and lock again${blockers.some((b) => b.owner === "executor") ? ", or lock: false to remove the executor lock" : ""}` };
      return buildResult({ operation: op, target, steps: [...inspect.steps, s, ...skippedSteps(plannedStepNames(plan), "refused because of the lock")], verification: notRequested(), summary: `${op} refused: ${s.error}. Nothing was sent.`, extra });
    }

    const activeBefore = seqAddr ? await playbackActive(bridge, seqAddr, t) : null;
    if (preview || (changes.length === 0 && !lockChange)) {
      const what = preview ? "Preview only; nothing was sent." : `Every requested value is already set on ${ref}; nothing was sent.`;
      return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: what, extra: { ...extra, preview, noop: !preview, playback: { activeBefore } } });
    }

    const { steps: mut, relockFailed } = await executePlan(ctx, plan);
    const steps = [...inspect.steps, ...mut];
    const warnings: string[] = [];
    if (relockFailed.length) warnings.push(`the lock on ${relockFailed.join(", ")} could not be restored: it may be left UNLOCKED`);
    let verification: Verification = notRequested();
    const readBackSteps: StepResult[] = [];
    let resulting: Record<string, unknown> | null = null;
    if (verify) {
      const expected: Record<string, string> = { ...modeClears };
      for (const c of changes) expected[c.property] = c.to;
      for (const flag of functionCustomFlags) if (expected[flag.property] === undefined) expected[flag.property] = displayOf(current[flag.property]);
      const finalExecLock = lock !== undefined ? lock : execLocked;
      const rb = await readBackObject(bridge, ref, expected, finalExecLock, changes.filter((change) => change.exact).map((change) => change.property));
      readBackSteps.push(rb.step);
      verification = rb.verification;
      resulting = rb.values;
    }
    for (const flag of functionCustomFlags) {
      if (!changes.some((change) => change.key === flag.key)) continue;
      const enabled = resulting ? yesNo(resulting[flag.property]) === true : custom.find((change) => change.property === flag.property)?.value === "Yes" || !custom.some((change) => change.property === flag.property) && yesNo(current[flag.property]) === true;
      if (enabled) warnings.push(`${flag.key} is stored as the fallback function; its custom command is enabled, so the executor still uses that command until custom_commands.${flag.key}.enabled is false`);
    }
    const activeAfter = seqAddr ? await playbackActive(bridge, seqAddr, t) : null;
    if (activeBefore === false && activeAfter === true) warnings.push(`${seqLabel} has active playback after the configuration although none was started by this tool (another client or an operator may have started it)`);
    const result = buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, resulting, playback: { activeBefore, activeAfter } } });
    result.steps.push(...readBackSteps);
    return result;
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// gma3_configure_sequence
// ---------------------------------------------------------------------------

/** Replaces each "#master:N" in `wanted` with speed master N's name (a read step). */
async function resolveMasterNames(bridge: Gma3Bridge, wanted: Record<string, string>, t: number): Promise<StepResult> {
  let names: Map<number, string>;
  try {
    const r = (await bridge.request("children", { ref: "ShowData.Masters.Speed", fields: ["Name"], limit: 50 }, t)) as { items?: ObjectSummary[] };
    names = new Map((r.items ?? []).filter((i) => typeof i.index === "number").map((i) => [i.index!, displayOf(i.fields?.Name ?? i.name)]));
  } catch (err) {
    return asRead(stepFromError("resolve_masters", err, { op: "children" }));
  }
  const resolved: Record<string, string> = {};
  for (const [k, w] of Object.entries(wanted)) {
    if (!w.startsWith(MASTER_TOKEN)) continue;
    const n = Number(w.slice(MASTER_TOKEN.length));
    const name = names.get(n) ?? "";
    if (!name) return asRead({ name: "resolve_masters", status: "failed", op: "children", error: `speed master ${n} ${names.has(n) ? "has no name" : "does not exist"}; sequences refer to speed masters by name` });
    if (name.toLowerCase() === "none") return asRead({ name: "resolve_masters", status: "failed", op: "children", error: `speed master ${n} is named "None", which the console reads as no master` });
    const shared = [...names].filter(([m, nm]) => m !== n && nm.toLowerCase() === name.toLowerCase()).map(([m]) => m);
    if (shared.length) return asRead({ name: "resolve_masters", status: "failed", op: "children", error: `speed master ${n} shares its name "${name}" with master(s) ${shared.join(", ")}; sequences refer to masters by name, so the link would be ambiguous. Rename one first` });
    wanted[k] = name;
    resolved[k] = `${n} (${name})`;
  }
  return asRead({ name: "resolve_masters", status: "succeeded", op: "children", detail: resolved });
}

export interface ConfigureSequenceArgs extends Record<string, unknown> {
  sequence: number;
  lock?: boolean;
  unlock?: boolean;
  preview?: boolean;
  verify?: boolean;
}

/** Sequence numbers from a list of numbers and "a Thru b" ranges (either direction), in the order given. */
export function expandSequenceList(value: unknown): { numbers: number[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: 'sequences must be a non-empty list of sequence numbers or "a Thru b" ranges' };
  const out: number[] = [];
  for (const entry of value) {
    const m = typeof entry === "string" ? entry.trim().match(/^(\d+)(?:\s+thru\s+(\d+))?$/i) : null;
    const from = typeof entry === "number" ? entry : m ? Number(m[1]) : NaN;
    const to = typeof entry === "number" ? entry : m ? Number(m[2] ?? m[1]) : NaN;
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= 9999)) return { error: `sequences: ${JSON.stringify(entry)} is not a sequence number 1-9999 or an "a Thru b" range` };
    const dir = to < from ? -1 : 1;
    for (let n = from; dir > 0 ? n <= to : n >= to; n += dir) {
      out.push(n);
      if (out.length > MAX_BATCH_ITEMS) return { error: `sequences expands to more than ${MAX_BATCH_ITEMS} sequences; split the job into several calls` };
    }
  }
  return { numbers: out };
}

export async function configureSequence(ctx: ToolContext, raw: ConfigureSequenceArgs): Promise<OperationResult> {
  const op = "configure_sequence";
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const wanted: Record<string, string> = {};
  for (const k of SETTING_KEYS) {
    const val = v.check(() => settingValue(k, SEQUENCE_SETTINGS[k], raw[k]));
    if (val !== undefined) wanted[k] = val;
  }
  const lock = v.check(() => optionalBool("lock", raw.lock));
  const unlock = raw.unlock === true;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { sequence: raw.sequence };
  if (v.ok && Object.keys(wanted).length === 0 && lock === undefined) v.errors.push("nothing to configure: give at least one setting or lock");
  if (!v.ok || sequence === undefined) return validationFailure(op, target, v.errors);
  const ref = `Sequence ${sequence}`;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  const body = async (): Promise<OperationResult> => {
    let current: Record<string, unknown> = {};
    let addr: string | undefined;
    const inspect = await runSteps([
      {
        name: "read_sequence",
        run: () =>
          objectsRead(bridge, "read_sequence", ref, SEQUENCE_READ_FIELDS, true, (item) => {
            if (!item) return { name: "read_sequence", status: "failed", op: "objects", error: `${ref} does not exist` };
            current = item.fields ?? {};
            addr = item.addr;
            // Every value the plan depends on must have been read: a missing one is unknown, never "unlocked" or "unchanged".
            const needed = ["Lock", "StructureLocked", "SystemLocked", ...Object.keys(wanted).map((k) => SEQUENCE_SETTINGS[k].property)];
            const unread = [...missingFields(current, needed), ...["StructureLocked", "SystemLocked"].filter((f) => !isMissing(current[f]) && yesNo(current[f]) === null)];
            if (unread.length) return { name: "read_sequence", status: "failed", op: "objects", detail: { values: current }, error: `${unread.join(", ")} of ${ref} could not be read; nothing was sent because the current values are unknown` };
            return { name: "read_sequence", status: "succeeded", op: "objects", detail: { name: current.Name, settings: readSettings(current), lock: displayOf(current.Lock) } };
          }),
      },
    ]);
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: `${op} was not performed; nothing was sent: ${inspect.steps[0]?.error ?? "inspection failed"}` });
    }
    // Speed and rate masters are written by name: resolve the numbers now, refusing a missing or shared name.
    if (Object.values(wanted).some((w) => w.startsWith(MASTER_TOKEN))) {
      const s = await resolveMasterNames(bridge, wanted, t);
      inspect.steps.push(s);
      if (s.status !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: `${op} was not performed; nothing was sent: ${s.error}` });
    }
    const refs = addr ? await findReferences(bridge, addr, t) : { complete: false, executors: [], pagesScanned: 0, requests: 0, error: "the sequence address is unknown" };
    const refStep: StepResult = asRead({ name: "find_references", status: "succeeded", op: "children", detail: refs });
    inspect.steps.push(refStep);

    const changes: Change[] = [];
    const unchanged: string[] = [];
    for (const [k, to] of Object.entries(wanted)) {
      const prop = SEQUENCE_SETTINGS[k].property;
      const from = displayOf(current[prop]);
      if (from.toLowerCase() === to.toLowerCase()) unchanged.push(k);
      else changes.push({ key: k, ref, property: prop, from, to });
    }
    const seqLocked = lockState(current.Lock) === true;
    const hardLocked = isYes(current.StructureLocked) || isYes(current.SystemLocked);
    const lockChange = lock !== undefined && lock !== seqLocked;
    if (lock !== undefined && !lockChange) unchanged.push("lock");
    const blocked = seqLocked && changes.length > 0 && lock !== false;
    const plan: MutationPlan = { unlocks: [], changes, relocks: [], finalLock: lockChange ? { ref, locked: lock! } : undefined };
    if (seqLocked && changes.length && lock === false) {
      plan.unlocks = [{ owner: "sequence", ref, locked: true }];
      plan.finalLock = undefined;
    } else if (blocked && unlock) {
      plan.unlocks = [{ owner: "sequence", ref, locked: true }];
      plan.relocks = [{ owner: "sequence", ref, locked: true }];
    }
    const warnings: string[] = [];
    const rw = referenceWarning(`Sequence ${sequence}`, refs);
    if (rw) warnings.push(rw);
    const intended = {
      changes: changes.map(({ key, property, from, to }) => ({ key, property, from, to })),
      unchanged,
      ...(lockChange ? { lock: { from: seqLocked, to: lock } } : {}),
      locked: seqLocked,
      unlockAndRelock: plan.relocks.map((r) => r.ref),
    };
    const extra = { name: current.Name, intended, references: refs };

    if (hardLocked) {
      const s: StepResult = { name: "check_locks", status: "failed", error: `${ref} is structure- or system-locked by the console; it cannot be configured` };
      return buildResult({ operation: op, target, steps: [...inspect.steps, s], verification: notRequested(), summary: `${op} refused: ${s.error}. Nothing was sent.`, warnings, extra });
    }
    if (blocked && !unlock) {
      const s: StepResult = { name: "check_locks", status: "failed", error: `${ref} is locked (its own Lock setting); the console would silently ignore the changes. Pass unlock: true to unlock, apply and lock again, or lock: false to remove the lock` };
      return buildResult({ operation: op, target, steps: [...inspect.steps, s, ...skippedSteps(plannedStepNames(plan), "refused because of the lock")], verification: notRequested(), summary: `${op} refused: ${s.error}. Nothing was sent.`, warnings, extra });
    }

    const activeBefore = await playbackActive(bridge, ref, t);
    if (preview || (changes.length === 0 && !lockChange)) {
      const what = preview ? "Preview only; nothing was sent." : `Every requested setting is already set on ${ref}; nothing was sent.`;
      return buildResult({ operation: op, target, steps: inspect.steps, verification: notRequested(), summary: what, warnings, extra: { ...extra, preview, noop: !preview, playback: { activeBefore } } });
    }

    const { steps: mut, relockFailed } = await executePlan(ctx, plan);
    const steps = [...inspect.steps, ...mut];
    if (relockFailed.length) warnings.push(`the lock on ${relockFailed.join(", ")} could not be restored: it may be left UNLOCKED`);
    let verification: Verification = notRequested();
    const readBackSteps: StepResult[] = [];
    let resulting: Record<string, unknown> | null = null;
    if (verify) {
      const expected: Record<string, string> = {};
      for (const c of changes) expected[c.property] = c.to;
      const rb = await readBackObject(bridge, ref, expected, lock !== undefined ? lock : seqLocked);
      readBackSteps.push(rb.step);
      verification = rb.verification;
      resulting = rb.values;
    }
    const activeAfter = await playbackActive(bridge, ref, t);
    if (activeBefore === false && activeAfter === true) warnings.push(`${ref} has active playback after the configuration although none was started by this tool (another client or an operator may have started it)`);
    const result = buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, resulting, playback: { activeBefore, activeAfter } } });
    result.steps.push(...readBackSteps);
    return result;
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Executor configuration load / recast
// ---------------------------------------------------------------------------

const configurationArgsSchema = z.object({
  action: z.enum(["load", "recast"]), configuration: z.number(), page: z.number().optional(), executor: z.number().optional(),
  executors: z.array(z.object({ data_pool: z.number(), page: z.number(), executor: z.number() })).optional(), apply: z.boolean().optional(), preview: z.boolean().optional(),
});
type ConfigurationArgs = z.infer<typeof configurationArgsSchema>;
interface ConfigurationTarget {
  page: number;
  executor: number;
  ref: string;
  assignedAddr: string;
  width: number;
  height: number;
}

async function configurationReferences(ctx: ToolContext, address: string): Promise<References> {
  const result: References = { complete: false, executors: [], pagesScanned: 0, requests: 1 };
  try {
    const base = currentPoolBridge(ctx.bridge);
    const raw = await base.request("children", { ref: "ShowData.DataPools", fields: ["No"], asText: false, limit: 64 }, ctx.requestTimeoutMs);
    const listing = completeListingSchema.safeParse(raw);
    if (!listing.success || listing.data.total === 0 || listing.data.total > 64) throw new Error("the complete data-pool list could not be read (maximum 64 pools)");
    for (const item of listing.data.items) {
      const number = leadingInt(item.fields?.No) ?? item.index;
      if (number === undefined || !Number.isInteger(number) || number < 1 || number > 9999) throw new Error("a data-pool number could not be read");
      result.requests++;
      const pool = completeListingSchema.safeParse(await base.request("children", { ref: `DataPool ${number}`, fields: [], asText: false, limit: 100 }, ctx.requestTimeoutMs));
      if (!pool.success) throw new Error(`DataPool ${number}: its children could not be read completely`);
      const pages = pool.data.items.find((child) => child.name?.toLowerCase() === "pages");
      if (!pages?.addr) throw new Error(`DataPool ${number}: the pages pool address is unreadable`);
      const references = await findReferencesWhere(base, (value) => value === address, ctx.requestTimeoutMs, "ExecutorConfiguration", pages.addr);
      result.pagesScanned += references.pagesScanned;
      result.requests += references.requests;
      for (const executor of references.executors) result.executors.push({ ...executor, data_pool: number, ref: `DataPool ${number} ${executor.ref}` });
      if (!references.complete) throw new Error(`DataPool ${number}: ${references.error ?? "incomplete page scan"}`);
    }
    result.complete = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** Saving a complete profile is unavailable through the qualified command path. */
export async function executorConfiguration(ctx: ToolContext, raw: ConfigurationArgs): Promise<OperationResult> {
  const op = "executor_configuration";
  const v = new Validator();
  const number = v.check(() => objectNumber("configuration", raw.configuration));
  const page = raw.page === undefined ? undefined : v.check(() => pageNumber("page", raw.page));
  const executor = raw.executor === undefined ? undefined : v.check(() => executorNumber("executor", raw.executor));
  if (raw.action === "load" && (page === undefined || executor === undefined || raw.executors !== undefined)) v.errors.push("load needs page and executor, and does not accept executors");
  if (raw.action === "recast" && (raw.page !== undefined || raw.executor !== undefined)) v.errors.push("recast addresses the complete reference list; omit page and executor");
  const expectedRefs: string[] = [];
  for (const item of raw.executors ?? []) {
    const pool = v.check(() => objectNumber("executors.data_pool", item.data_pool, { max: 9999 }));
    const p = v.check(() => pageNumber("executors.page", item.page));
    const e = v.check(() => executorNumber("executors.executor", item.executor));
    if (pool !== undefined && p !== undefined && e !== undefined) expectedRefs.push(`DataPool ${pool} ${executorRef(p, e)}`);
  }
  if (duplicates(expectedRefs).length) v.errors.push("executors must not contain duplicate targets");
  const target = { configuration: raw.configuration, action: raw.action, ...(dataPoolOf(ctx.bridge) === undefined ? {} : { data_pool: dataPoolOf(ctx.bridge) }) };
  if (!v.ok || number === undefined) return validationFailure(op, target, v.errors);
  const ref = `Configuration ${number}`;
  const body = async (): Promise<OperationResult> => {
    const state: { configuration?: { addr: string; width: number; height: number }; targets: ConfigurationTarget[] } = { targets: [] };
    const steps: StepResult[] = [];
    const configRead = await objectsRead(ctx.bridge, "read_configuration", ref, ["Width", "Height"], false, (item) => {
      const width = leadingInt(item?.fields?.Width);
      const height = leadingInt(item?.fields?.Height);
      if (!item || item.class !== "Configuration" || !item.addr || width === undefined || height === undefined) return { name: "read_configuration", status: "failed", op: "objects", error: `${ref} does not exist or its class, address or size is unreadable` };
      state.configuration = { addr: item.addr, width, height };
      return { name: "read_configuration", status: "succeeded", op: "objects", detail: state.configuration };
    });
    steps.push(configRead);
    const configuration = state.configuration;
    if (configRead.status !== "succeeded" || !configuration) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `${op} refused: ${configRead.error}. Nothing was sent.` });
    let targets: Array<{ page: number; executor: number; ref: string }>;
    if (raw.action === "load" && page !== undefined && executor !== undefined) targets = [{ page, executor, ref: executorRef(page, executor) }];
    else {
      const references = await configurationReferences(ctx, configuration.addr);
      steps.push(asRead({ name: "find_references", status: references.complete ? "succeeded" : "failed", op: "children", detail: references, ...(references.complete ? {} : { error: references.error }) }));
      if (!references.complete) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: "Recast refused because its complete affected executor list could not be read. Nothing was sent.", extra: { references } });
      targets = references.executors;
      if (raw.apply === true && (raw.executors === undefined || JSON.stringify([...expectedRefs].sort()) !== JSON.stringify(targets.map((item) => item.ref).sort()))) {
        steps.push(asRead({ name: "check_apply_plan", status: "failed", error: "executors must exactly match the fresh complete affected list before apply: true" }));
        return buildResult({ operation: op, target, steps, verification: notRequested(), summary: "Recast apply plan does not match the current affected executors. Nothing was sent.", extra: { affectedExecutors: targets } });
      }
    }
    for (const item of targets) {
      const pageRef = item.ref.slice(0, item.ref.lastIndexOf("."));
      const pageRead = await objectsRead(ctx.bridge, `check_page_${item.page}`, pageRef, ["Lock"], true, (object) => {
        if (!object || lockState(object.fields?.Lock) !== false) return { name: `check_page_${item.page}`, status: "failed", op: "objects", error: `Page ${item.page} is missing, locked or its lock is unreadable; unlock it explicitly before configuration` };
        return { name: `check_page_${item.page}`, status: "succeeded", op: "objects" };
      });
      steps.push(pageRead);
      if (pageRead.status !== "succeeded") break;
      const execRead = await objectsRead(ctx.bridge, `check_${item.ref}`, item.ref, ["Object", "Width", "Height", "Lock", "StructureLocked", "SystemLocked"], false, (object) => {
        const assigned = toAssigned(object?.fields?.Object);
        const width = leadingInt(object?.fields?.Width);
        const height = leadingInt(object?.fields?.Height);
        if (!object || object.class !== "Executor" || !assigned?.addr || assigned.class !== "Sequence" && assigned.class !== "Macro" || width === undefined || height === undefined || lockState(object.fields?.Lock) !== false || yesNo(object.fields?.StructureLocked) !== false || yesNo(object.fields?.SystemLocked) !== false) return { name: `check_${item.ref}`, status: "failed", op: "objects", error: `${item.ref} is missing, covered, locked, unsupported or has unreadable assignment/size/protection; nothing was sent` };
        state.targets.push({ ...item, assignedAddr: assigned.addr, width, height });
        return { name: `check_${item.ref}`, status: "succeeded", op: "objects", detail: { assigned, width, height } };
      });
      steps.push(execRead);
      if (execRead.status !== "succeeded") break;
      if (raw.action === "load") {
        const current = state.targets.at(-1);
        if (current) steps.push(await checkExecutorSize(ctx, item.page, item.executor, current.width, current.height, configuration.width, configuration.height));
        if (steps.at(-1)?.status !== "succeeded") break;
      }
    }
    const extra = { action: raw.action, configurationRef: ref, affectedExecutors: targets, profileVerification: "unavailable: complete saved function profile is not exposed", sizeEffect: raw.action === "recast" ? "existing executor sizes are preserved" : { width: configuration.width, height: configuration.height } };
    const bad = steps.find((step) => step.status !== "succeeded");
    if (bad) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `${op} refused: ${bad.error}. Nothing was sent.`, extra });
    if (raw.preview === true || raw.action === "recast" && raw.apply !== true || targets.length === 0) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: "Configuration plan only; nothing was sent. Recast requires apply: true and executors matching this affected list.", extra: { ...extra, preview: true } });
    const firstTarget = targets[0];
    if (!firstTarget) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: "No affected executor remains; nothing was sent.", extra });
    const command = raw.action === "load" ? `Assign ${ref} At ${firstTarget.ref}` : `Recast ${ref}`;
    steps.push(await commandStep(ctx.bridge, raw.action, command, ctx.requestTimeoutMs));
    const readBackSteps: StepResult[] = [];
    const checks: Verification[] = [];
    const resulting: Array<Record<string, unknown>> = [];
    for (const item of state.targets) {
      const read = await objectsRead(ctx.bridge, `read_back_${item.ref}`, item.ref, ["Object", "ExecutorConfiguration", "Width", "Height", ...FUNCTION_KEYS.map((key) => EXECUTOR_FUNCTIONS[key].property)], false, (object) => {
        if (!object) return { name: `read_back_${item.ref}`, status: "failed", op: "objects", error: `${item.ref} could not be read back` };
        const fields = object.fields ?? {};
        const expected = { configurationAddr: configuration.addr, objectAddr: item.assignedAddr, Width: raw.action === "load" ? configuration.width : item.width, Height: raw.action === "load" ? configuration.height : item.height };
        const actual = { configurationAddr: toAssigned(fields.ExecutorConfiguration)?.addr, objectAddr: toAssigned(fields.Object)?.addr, Width: fields.Width, Height: fields.Height };
        checks.push(compareFields(`configuration identity, unchanged assigned object and size of ${item.ref}; full function profile is unavailable`, expected, actual));
        resulting.push({ ref: item.ref, ...actual, functions: readFunctions(fields), custom_commands: null });
        return { name: `read_back_${item.ref}`, status: "succeeded", op: "objects", detail: actual };
      });
      readBackSteps.push(read);
      if (read.status !== "succeeded") checks.push(unavailable(read.error ?? "read-back failed", item.ref));
      else {
        readBackSteps.push(await objectsRead(ctx.bridge, `read_commands_${item.ref}`, item.ref, CUSTOM_COMMAND_FIELDS, true, (object) => {
          const entry = resulting.find((value) => value.ref === item.ref);
          if (!object || !entry) return { name: `read_commands_${item.ref}`, status: "failed", op: "objects", error: "stored custom command text could not be read in the Edit role" };
          entry.custom_commands = readCustomCommands(object.fields ?? {});
          return { name: `read_commands_${item.ref}`, status: "succeeded", op: "objects", detail: entry.custom_commands };
        }));
      }
    }
    const verified: Verification = { status: "matched", checked: "configuration identity, unchanged assigned object and size for every affected executor; complete saved function profile is not verified" };
    const verification = checks.find((check) => check.status === "mismatched") ?? checks.find((check) => check.status === "unavailable") ?? verified;
    const result = buildResult({ operation: op, target, steps, verification, warnings: ["Only configuration identity, assigned-object preservation and dimensions are verified; inspect the returned functions before using the executor."], extra: { ...extra, resulting } });
    result.steps.push(...readBackSteps);
    return result;
  };
  return raw.preview === true || raw.action === "recast" && raw.apply !== true ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EXECUTOR_DESC = "Executor number on that page: 101-190 (keys), 201-290 (faders), 301-390 and 401-490 (knobs), plus the Xkeys 191-198 and 291-298.";
const COMMON =
  "Never sends Go, On, Off, Toggle, Flash or any other playback keyword and does not touch the selection, the programmer or fader levels; playback state is read before and after (playback.activeBefore/activeAfter) and configuration alone does not start playback. " +
  "A locked target is refused before anything is sent (the console silently ignores writes to it) unless unlock: true, which unlocks the owning object, applies the changes and locks it again (relocking is attempted even after a failed change). " +
  "preview: true performs only the reads and returns the planned changes (from -> to); values already set are reported as unchanged and never sent. " +
  "Each value is written with one 'set' request whose reply must read back the requested value, because the console silently keeps the previous value for anything it does not accept; the first failure stops the remaining changes. " +
  "A value that could not be read is unknown, never a default: the call is refused when a value the plan depends on (requested property, Lock, page Lock) is missing, and a set reply without a value is an unknown step. " +
  "verify (default true) reads every changed property and the lock back. Mutations from this server are serialised, but not isolated from other operators or clients.";

const fnSchema = (k: FunctionKey) => z.string().optional().describe(`${EXECUTOR_FUNCTIONS[k].property}: Sequence choices ${EXECUTOR_FUNCTIONS[k].allowed.join(", ")}; Macro choices ${allowedFunction("Macro", k).join(", ")}. Empty clears it.`);

export const registerPlaybackTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_executor_configuration",
    {
      title: "Load or recast an executor configuration",
      description: "Load an existing Configuration onto an explicit page/executor, or plan and recast its functions on every referencing executor. Uses Assign Configuration <n> At Page <p>.<e> or Recast Configuration <n>. " +
        "Load checks full page occupancy against the configuration size first. Recast defaults to a read-only plan: it scans all data pools (maximum64), pages(maximum200 per pool), and requires apply:true with executors exactly matching the fresh affected list, each {data_pool,page,executor}. Recast preserves existing executor sizes. " +
        "Missing/unreadable targets and page/executor locks are refused; unlock explicitly first. preview:true sends nothing. Does not change selection, programmer, fader levels or trigger playback; stored custom commands are not executed. " +
        "Read-back verifies configuration identity, unchanged assigned object and expected dimensions; returned functions are observations, not verification of the complete saved profile (that profile is unavailable). Saving profiles is unsupported because Store Page At Configuration returned OK without storing one. " +
        "Mutations are serialised within this server; other operators/clients can change references after the plan. An uncertain command is never retried.",
      inputSchema: {
        ...dataPoolShape,
        ...configurationArgsSchema.shape,
      },
    },
    async (args) => operation(() => executorConfiguration(inDataPool(ctx, args), args)),
  );
  server.registerTool(
    "gma3_executor_settings",
    {
      title: "Inspect an executor and its sequence's playback settings",
      description:
        "Read-only. For Page <p>.<e>: the assigned object; the executor's key, MA-key, fader and encoder functions, Fix and Lock; the page lock; " +
        "for a sequence executor also the allowed function choices, the sequence's playback settings (wrap_around, priority, restart_mode, release_first_cue, auto_start/stop, master_go_mode, protect flags, ...), its Lock, whether it has active playback, " +
        "which object owns each protection setting, and every executor in the current data pool that references the same sequence (sequence settings apply to all of them). " +
        "The sequence is read by the address the executor reports, so a sequence from another data pool is reported as such (dataPool: other, ref: null). A value that could not be read is null and listed in unreadable. Sends no command and changes nothing.",
      inputSchema: {
        ...dataPoolShape,
        page: z.number().describe("Executor page number (1-9999)."),
        executor: z.number().describe(EXECUTOR_DESC),
        references: z.boolean().optional().describe("Scan every page for executors sharing the sequence (default true)."),
      },
    },
    async (args) => {
      try {
        return json(await executorSettings(inDataPool(ctx, args), args));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_configure_executor",
    {
      title: "Configure executor functions, custom commands and size",
      description:
        "Set key, MA-key, fader, encoder and MA-encoder functions, custom command triplets, Width/Height and Fix of the Sequence or Macro executor at Page <p>.<e> by writing its properties. " +
        "Unlike 'Assign <function> At', this never clears an unrelated unpress function. Functions are validated against the assigned class before writes; Macro faders/encoders allow only Empty. Sequence Flash, Temp, Swap, Black and Time are key-only. " +
        "Custom command text is stored, never executed; command requires explicit enabled because the console auto-enables text. The flag is written after the text, even when initially unchanged. Commands preserve exact case and internal spaces; edge whitespace is refused because object reads trim it. " +
        "Encoder continuous functions and left/right actions or enabled custom commands are mutually exclusive: conflicting requests fail before reads, and implicit mode clears are reported and verified. Storing disabled encoder text against an active continuous mode is refused unless that mode is explicitly cleared. " +
        "Size changes check complete page occupancy, expanded footprints and proxies; collisions, unreadable or failed enumeration and expansion beyond page bounds are refused before any write. Shrinks precede growth. " +
        "Executor settings belong to this executor only; sequence settings (Wrap Around, priority, ...) are configured with gma3_configure_sequence. lock: true/false sets the executor's own Lock. A page lock also blocks executor changes. " +
        COMMON,
      inputSchema: {
        ...dataPoolShape,
        page: z.number().describe("Executor page number (1-9999); the page must exist."),
        executor: z.number().describe(EXECUTOR_DESC),
        key_press: fnSchema("key_press"),
        key_unpress: fnSchema("key_unpress"),
        ma_key_press: fnSchema("ma_key_press"),
        ma_key_unpress: fnSchema("ma_key_unpress"),
        fader: fnSchema("fader"),
        encoder: fnSchema("encoder"),
        encoder_left: fnSchema("encoder_left"),
        encoder_right: fnSchema("encoder_right"),
        ma_encoder: fnSchema("ma_encoder"),
        ma_encoder_left: fnSchema("ma_encoder_left"),
        ma_encoder_right: fnSchema("ma_encoder_right"),
        custom_commands: customCommandsSchema.optional().describe("Stored custom commands per discrete trigger. Each has command (one line; empty clears; requires explicit enabled), enabled and add_executor. Text is saved before flags; commands are never executed. Enabled encoder commands choose discrete mode and clear the continuous encoder function."),
        width: z.number().optional().describe("Width in executor cells, 1-5. Full page occupancy is checked first; overlapping assignments, incomplete scans, page boundaries and Xkey expansion are refused."),
        height: z.number().optional().describe("Height in executor rows, 1-4. Extends toward higher numbered rows, never beyond row 4. The tool refuses collisions before changing size."),
        fix: z.boolean().optional().describe("Fix the executor on every page (Fix)."),
        lock: z.boolean().optional().describe("Final state of the executor's own Lock; lock: false on a locked executor removes the lock (explicit unlock)."),
        unlock: z.boolean().optional().describe("Allow unlocking a locked executor and/or page for this call; the locks are restored afterwards (default false: refuse)."),
        preview: z.boolean().optional().describe("Only read and report the planned changes (default false)."),
        verify: z.boolean().optional().describe("Read the changed properties back and compare (default true)."),
      },
    },
    async (args) => operation(() => configureExecutor(inDataPool(ctx, args), args)),
  );

  const settingSchema: Record<string, z.ZodTypeAny> = {};
  for (const k of SETTING_KEYS) {
    const def = SEQUENCE_SETTINGS[k];
    settingSchema[k] =
      def.kind === "bool"
        ? z.boolean().optional().describe(`${def.property} (Yes/No).`)
        : def.kind === "master"
          ? z.union([z.number(), z.literal("none")]).optional().describe(`${def.property}: a speed master 1-16 or "none".`)
          : z.string().optional().describe(`${def.property}: ${Object.keys(def.values).join(", ")}.`);
  }

  server.registerTool(
    "gma3_configure_sequence",
    {
      title: "Configure a sequence's playback settings",
      description:
        "Set a sequence's playback settings by writing its properties: wrap_around (a chase loops only with Wrap Around on and a trigger on its first cue), priority, restart_mode, release_first_cue, auto_start, auto_stop, master_go_mode, auto_fix, auto_stomp, tracking, soft_ltp, " +
        "off_when_overridden, kill_protect, swap_protect (protection from the Kill/Swap playback actions, not from editing), use_executor_time, include_link_last_go, xfade_mode, xfade_reload. lock: true/false sets the sequence's own Lock. " +
        "Tempo links (SB-06): rate_master (a speed master 1-16 or \"none\": the cue timing (fades, delays, trigger times) runs at its effective BPM / 60, so 60 BPM is 1:1), speed_master (the phasers in the cues follow it), rate_scale and speed_scale (One, Mul2..Mul256, Div2..Div256), speed_from_rate. Masters are linked by name; a master without a unique name is refused. While a rate master is linked, moving the sequence's rate fader moves the shared master. " +
        "Settings belong to the sequence, so they apply to EVERY executor that references it: the tool scans all pages and lists them (references) and warns when other executors share the sequence. Cue triggers and timing are set with gma3_set_cue_trigger / gma3_set_cue_timing. " +
        COMMON +
        " Batch form (sequences): the same settings on a list of sequences and ranges (\"1 Thru 17\"), each configured, checked and read back on its own; the result has one line per sequence (detail: true for every step).",
      inputSchema: {
        ...dataPoolShape,
        sequence: z.number().optional().describe("Sequence number (must exist). Required unless sequences is given."),
        sequences: z
          .array(z.union([z.number(), z.string()]))
          .optional()
          .describe('Batch form: the same settings on several sequences: numbers and "a Thru b" ranges, e.g. [1, "3 Thru 17", 20]; each sequence is configured and read back on its own.'),
        ...settingSchema,
        lock: z.boolean().optional().describe("Final state of the sequence's Lock; lock: false on a locked sequence removes the lock (explicit unlock)."),
        unlock: z.boolean().optional().describe("Allow unlocking a locked sequence for this call; the lock is restored afterwards (default false: refuse)."),
        preview: z.boolean().optional().describe("Only read and report the planned changes and sharing executors (default false)."),
        verify: z.boolean().optional().describe("Read the changed settings back and compare (default true)."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(async () => {
        const a = args as Record<string, unknown>;
        const scoped = inDataPool(ctx, a);
        if (a.sequences === undefined) return configureSequence(scoped, a as ConfigureSequenceArgs);
        const expanded = expandSequenceList(a.sequences);
        if ("error" in expanded) return batchRefused("configure_sequence", "sequences", [expanded.error]);
        return runBatchCall({ ...a, sequences: expanded.numbers.map((sequence) => ({ sequence })) }, {
          ctx: scoped,
          operation: "configure_sequence",
          listKey: "sequences",
          identityKeys: ["sequence"],
          label: (it) => `Sequence ${String(it.sequence)}`,
          key: (it) => `Sequence ${String(it.sequence)}`,
          check: (items) => duplicates(items.map((it) => String(it.sequence))).map((n) => `Sequence ${n} is listed more than once in sequences`),
          run: (it, c) => configureSequence(c, it as ConfigureSequenceArgs),
        });
      }),
  );
};
