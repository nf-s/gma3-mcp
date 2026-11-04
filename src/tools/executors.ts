/**
 * FR-06: executor assignment and labelling tools.
 *
 *   gma3_assign_to_executor  Assign Sequence <n> At Page <p>.<e>   (+ optional label)
 *   gma3_label_executor      Label Page <p>.<e> "<name>"
 *
 * Both tools inspect the executor read-only before changing it, run every mutation inside the
 * shared mutation lock, never retry, stop at the first non-success and never send a playback
 * keyword (Go/On/Off/Toggle/...). They only use the existing bridge ops `objects` and `cmd`.
 *
 * Console facts confirmed on onPC 2.5.1 (manual, read-only inspection and the live run):
 *   - Executor numbers are row*100 + column with rows 1..4 and columns 1..90
 *     (101-190 keys, 201-290 faders, 301-390 and 401-490 knobs); the Xkeys are 191-198 / 291-298.
 *   - `Assign Sequence 4 At Page 2.301` is the documented syntax and returns "OK". The page must
 *     already exist (`Store Page <p>` creates one).
 *   - `Page <p>.<e>` resolves to the Executor object on any page (not only the current one). Its
 *     `Object` property is the assigned object; read with asText=false it comes back as a handle
 *     summary {name, class, addr, index}, which lets us compare identity by address, not by name.
 *   - An executor has NO label of its own on 2.5.1: its Name always shows the assigned object's
 *     name. Setting Name on the executor object is silently ignored, and `Label Page p.e "x"`
 *     renames the ASSIGNED object (the sequence), everywhere it appears. The label tools are
 *     therefore defined as "label the object assigned to this executor".
 *   - The console silently strips  \ " $ & * ? , . ; ^ { } | ~  from names; objectName() refuses
 *     them up front so a label is never silently altered.
 *   - An empty executor and an executor on a missing page both resolve to nothing, which is why
 *     the page is checked separately.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { readObjects, type ObjectSummary } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import {
  asRead,
  buildResult,
  commandStep,
  compareFields,
  notRequested,
  runSteps,
  stepFromError,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
  type StepStatus,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, finiteNumber, objectName, objectNumber } from "../validate.js";
import { dataPoolOf, dataPoolShape, inDataPool } from "./datapool.js";

// ---------------------------------------------------------------------------
// Module-local validation
// ---------------------------------------------------------------------------

/**
 * Executor number: row*100 + column with rows 1..4 and columns 1..90 (101-190, 201-290, 301-390,
 * 401-490). The 16 Xkeys are executors 191-198 and 291-298, so rows 1 and 2 extend to column 98.
 */
export function executorNumber(field: string, value: unknown): number {
  const n = finiteNumber(field, value, { integer: true })!;
  const row = Math.floor(n / 100);
  const col = n % 100;
  const maxCol = row <= 2 ? 98 : 90;
  if (row < 1 || row > 4 || col < 1 || col > maxCol) {
    throw new ValidationError(`${field} must be an executor number (101-190, 201-290, 301-390 or 401-490, plus Xkeys 191-198 and 291-298; got ${n})`, field);
  }
  return n;
}

/** Executor page number 1..9999 (the manual's limit per data pool). */
export function pageNumber(field: string, value: unknown): number {
  return objectNumber(field, value, { max: 9999 })!;
}

export const executorRef = (page: number, executor: number): string => `Page ${page}.${executor}`;

/** A single qualified pool object, never a range or a command fragment. */
export function executorObjectReference(field: string, value: unknown): string {
  const parsed = z.string().trim().regex(/^(?:DataPool\s+[1-9]\d*\s+)?(?:Sequence|Macro)\s+[1-9]\d*$/i).safeParse(value);
  if (!parsed.success) throw new ValidationError(`${field} must name one Sequence or Macro by number, optionally qualified with DataPool <n>`, field);
  const match = parsed.data.match(/^(?:DataPool\s+(\d+)\s+)?(Sequence|Macro)\s+(\d+)$/i);
  if (!match) throw new ValidationError(`${field} could not be resolved`, field);
  const pool = match[1] === undefined ? undefined : objectNumber(`${field}.data_pool`, Number(match[1]), { max: 9999 });
  const number = objectNumber(field, Number(match[3]));
  return `${pool === undefined ? "" : `DataPool ${pool} `}${match[2].toLowerCase() === "sequence" ? "Sequence" : "Macro"} ${number}`;
}

// ---------------------------------------------------------------------------
// Read-only inspection (objects op, asText=false so handles keep class and address)
// ---------------------------------------------------------------------------

export interface AssignedObject {
  name?: string;
  class?: string;
  addr?: string;
  index?: number;
}

export interface ExecutorState {
  /** True when nothing is assigned (the executor does not exist on the page or has no object). */
  empty: boolean;
  /** The executor's Name property. On 2.5.1 this is always the assigned object's name. */
  name?: string | null;
  /** The assigned object, when there is one. */
  object?: AssignedObject | null;
}

/**
 * A read-only inspection step (StepResult.kind "read"): reads one object through the shared
 * `objects` helper with asText=false so handle-valued properties keep name, class and address.
 * `interpret` receives the object summary (null when nothing matches) and decides the status.
 */
function inspectStep(bridge: Gma3Bridge, name: string, ref: string, fields: string[], interpret: (item: ObjectSummary | null) => StepResult): () => Promise<StepResult> {
  return async () => {
    try {
      const res = await readObjects(bridge, ref, fields, 1, { asText: false });
      const item = res?.items?.[0];
      if (item?.fieldErrors !== undefined) {
        const errors = z.record(z.string(), z.unknown()).safeParse(item.fieldErrors);
        if (!errors.success || Object.keys(errors.data).length) return asRead({ name, status: "failed", op: "objects", error: `requested fields of ${ref} could not be read without errors`, detail: item.fieldErrors });
      }
      return asRead(interpret(!item || item.invalid ? null : item));
    } catch (err) {
      return asRead(stepFromError(name, err, { op: "objects", detail: { ref, fields } }));
    }
  };
}

function toAssigned(value: unknown): AssignedObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : { name: value };
  if (typeof value === "object") {
    const parsed = z.object({ name: z.string().optional(), class: z.string().optional(), addr: z.string().optional(), index: z.number().optional() }).safeParse(value);
    if (!parsed.success) return null;
    const v = parsed.data;
    const out: AssignedObject = {};
    if (typeof v.name === "string") out.name = v.name;
    if (typeof v.class === "string") out.class = v.class;
    if (typeof v.addr === "string") out.addr = v.addr;
    if (typeof v.index === "number") out.index = v.index;
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function executorState(item: ObjectSummary | null): ExecutorState {
  if (!item) return { empty: true };
  const f = item.fields ?? {};
  const object = toAssigned(f.Object);
  const nameField = f.Name;
  const name = typeof nameField === "string" ? nameField : item.name ?? null;
  return { empty: object === null, name, object };
}

/** Compare the executor's assigned object with a sequence read from the pool. */
function isSameObject(assigned: AssignedObject | null | undefined, seq: AssignedObject): boolean {
  if (!assigned) return false;
  if (assigned.addr && seq.addr) return assigned.addr === seq.addr;
  return false;
}

function describeAssigned(a: AssignedObject | null | undefined): string {
  if (!a) return "nothing";
  const parts = [a.class, a.index !== undefined ? String(a.index) : undefined].filter(Boolean).join(" ");
  return parts ? `${parts} "${a.name ?? ""}"` : `"${a.name ?? ""}"`;
}

/** A command-line reference for an assigned object, for reading it back; null when unknown. */
function assignedObjectRef(a: AssignedObject | null | undefined): string | null {
  if (!a) return null;
  if (a.class && a.index !== undefined) return `${a.class} ${a.index}`;
  if (a.addr) return a.addr;
  return null;
}

// ---------------------------------------------------------------------------
// Steps and result assembly
// ---------------------------------------------------------------------------

/** `Label Page p.e "name"`: renames the object assigned to the executor (see header). */
function labelStep(bridge: Gma3Bridge, ref: string, label: string, timeoutMs: number): () => Promise<StepResult> {
  return () => commandStep(bridge, "label", `Label ${ref} "${label}"`, timeoutMs);
}

/** Append `skipped` entries for steps that were never reached. */
function skipped(names: string[], because: StepStatus | "refused"): StepResult[] {
  return names.map((name) => ({ name, status: "skipped" as const, error: `not attempted: ${because === "refused" ? "the request was refused before any command was sent" : `an earlier step was ${because}`}` }));
}

const firstBad = (steps: StepResult[]) => steps.find((s) => s.status === "failed" || s.status === "unknown");

/**
 * Build the final result. Read-only steps carry kind "read", so buildResult/outcomeOf already
 * ignore them as "completed work": a refusal or failure before the first mutation is `failed`,
 * "already assigned" with nothing to send is `succeeded`, and a lost read-back after a mutation
 * leaves the outcome untouched with verification `unavailable`. Only the summary is specialised
 * here, for the case where nothing was sent.
 */
function finalize(o: {
  operation: string;
  target: Record<string, unknown>;
  steps: StepResult[];
  verification: Verification;
  mutated: boolean;
  noop: boolean;
  summary?: string;
  warnings?: string[];
  extra?: Record<string, unknown>;
  /**
   * Read-back steps. They are appended to `steps` after the outcome has been computed: a failed or
   * lost read-back only makes `verification` unavailable, it never changes what the mutation did.
   */
  readBackSteps?: StepResult[];
}): OperationResult {
  let summary = o.summary;
  if (summary === undefined && !o.mutated && !o.noop) {
    const bad = firstBad(o.steps);
    summary = `${o.operation} was not performed; nothing was sent to the console${bad ? `: ${bad.error ?? bad.name}` : ""}.`;
  }
  const result = buildResult({ operation: o.operation, target: o.target, steps: o.steps, verification: o.verification, summary, warnings: o.warnings, extra: o.extra });
  if (o.readBackSteps?.length) result.steps.push(...o.readBackSteps);
  return result;
}

/**
 * Read-back shared by both tools: the executor (Object, Name) and, when a label was applied and
 * the assigned object can be addressed, the assigned object's own Name. Returns the steps run,
 * the resulting executor state and the verification.
 */
async function readBack(
  bridge: Gma3Bridge,
  ref: string,
  expected: { objectName: string; objectClass?: string; objectAddr?: string; label?: string },
  objectRef: string | null,
): Promise<{ steps: StepResult[]; resulting: ExecutorState | null; objectName: string | null; verification: Verification }> {
  let resulting: ExecutorState | null = null;
  let objectNameRead: string | null = null;
  const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [
    {
      name: "read_back",
      run: inspectStep(bridge, "read_back", ref, ["Object", "Name"], (item) => {
        resulting = executorState(item);
        return { name: "read_back", status: "succeeded", op: "objects", detail: resulting };
      }),
    },
  ];
  if (expected.label !== undefined && objectRef) {
    plan.push({
      name: "read_back_object",
      run: inspectStep(bridge, "read_back_object", objectRef, ["Name"], (item) => {
        if (!item) return { name: "read_back_object", status: "failed", op: "objects", error: `${objectRef} could not be read back` };
        const n = item.fields?.Name;
        objectNameRead = typeof n === "string" ? n : item.name ?? null;
        return { name: "read_back_object", status: "succeeded", op: "objects", detail: { ref: objectRef, name: objectNameRead } };
      }),
    });
  }
  const { steps } = await runSteps(plan);
  const bad = firstBad(steps);
  if (bad || !resulting) {
    return { steps, resulting, objectName: objectNameRead, verification: unavailable(bad?.error ?? "read-back failed", `assigned object of ${ref}`) };
  }
  const r: ExecutorState = resulting;
  const want: Record<string, unknown> = { object: expected.objectName };
  if (expected.objectClass) want.objectClass = expected.objectClass;
  if (expected.objectAddr) want.objectAddr = expected.objectAddr;
  if (expected.label !== undefined) {
    want.name = expected.label;
    if (objectRef) want.assignedObjectName = expected.label;
  }
  const got: Record<string, unknown> = {
    object: r.object?.name ?? null,
    objectClass: r.object?.class ?? null,
    objectAddr: r.object?.addr ?? null,
    name: r.name ?? null,
    ...(objectRef && expected.label !== undefined ? { assignedObjectName: objectNameRead } : {}),
  };
  const checked = expected.label !== undefined ? `assigned object, executor Name and the assigned object's Name (${objectRef ?? "unaddressable"}) of ${ref}` : `assigned object of ${ref}`;
  return { steps, resulting, objectName: objectNameRead, verification: compareFields(checked, want, got) };
}

// ---------------------------------------------------------------------------
// gma3_assign_to_executor
// ---------------------------------------------------------------------------

interface AssignArgs {
  sequence?: number;
  object?: string;
  page?: number;
  executor?: number;
  replace?: boolean;
  label?: string;
  verify?: boolean;
}

export async function assignToExecutor(ctx: ToolContext, raw: AssignArgs): Promise<OperationResult> {
  const op = "assign_to_executor";
  const v = new Validator();
  if ((raw.sequence === undefined) === (raw.object === undefined)) v.errors.push("give exactly one of sequence or object");
  const sequence = raw.sequence === undefined ? undefined : v.check(() => objectNumber("sequence", raw.sequence));
  const sourceRef = raw.object === undefined ? sequence === undefined ? undefined : `Sequence ${sequence}` : v.check(() => executorObjectReference("object", raw.object));
  const page = v.check(() => pageNumber("page", raw.page));
  const executor = v.check(() => executorNumber("executor", raw.executor));
  const label = v.check(() => objectName("label", raw.label, { optional: true }));
  const replace = raw.replace === true;
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { ...(raw.object === undefined ? { sequence: raw.sequence } : { object: raw.object }), page: raw.page, executor: raw.executor };
  if (dataPoolOf(ctx.bridge) !== undefined) target.data_pool = dataPoolOf(ctx.bridge);
  if (!v.ok || sourceRef === undefined || page === undefined || executor === undefined) return validationFailure(op, target, v.errors);

  const ref = executorRef(page, executor);
  target.executorRef = ref;
  const t = ctx.requestTimeoutMs;
  const bridge = ctx.bridge;
  const command = `Assign ${sourceRef} At ${ref}`;
  const checkSource = raw.object === undefined ? "check_sequence" : "check_object";
  const plannedMutations = ["assign", ...(label !== undefined ? ["label"] : [])];
  const plannedReads = verify ? ["read_back", ...(label !== undefined ? ["read_back_object"] : [])] : [];

  return ctx.mutations.run(async () => {
    let seq: AssignedObject = {};
    let previous: ExecutorState = { empty: true };

    // Phase 1: read-only inspection. Nothing is sent to the console if any of these fail.
    const inspect = await runSteps([
      {
        name: checkSource,
        run: inspectStep(bridge, checkSource, sourceRef, ["Name"], (item) => {
          if (!item) return { name: checkSource, status: "failed", op: "objects", error: `${sourceRef} does not exist` };
          if (!item.addr) return { name: checkSource, status: "failed", op: "objects", error: `${sourceRef} has no readable address; assignment identity cannot be checked` };
          const sourceClass = /(?:^|\s)Macro\s/i.test(sourceRef) ? "Macro" : "Sequence";
          if (item.class !== sourceClass) return { name: checkSource, status: "failed", op: "objects", error: `${sourceRef} resolved to ${item.class ?? "an unreadable class"}, expected ${sourceClass}` };
          const nameField = item.fields?.Name;
          seq = { name: typeof nameField === "string" ? nameField : item.name, class: item.class ?? "Sequence", addr: item.addr, index: item.index };
          return { name: checkSource, status: "succeeded", op: "objects", detail: seq };
        }),
      },
      {
        name: "check_page",
        run: inspectStep(bridge, "check_page", `Page ${page}`, ["Name"], (item) => {
          if (!item) {
            return { name: "check_page", status: "failed", op: "objects", error: `Page ${page} does not exist. Executors can only be addressed on an existing page; create it first (Store Page ${page})` };
          }
          return { name: "check_page", status: "succeeded", op: "objects", detail: { name: item.name, addr: item.addr } };
        }),
      },
      {
        name: "inspect_executor",
        run: inspectStep(bridge, "inspect_executor", ref, ["Object", "Name"], (item) => {
          if (item?.class === "Proxy") return { name: "inspect_executor", status: "failed", op: "objects", error: `${ref} is covered by an expanded executor; assign to its owning executor instead` };
          previous = executorState(item);
          return { name: "inspect_executor", status: "succeeded", op: "objects", detail: previous };
        }),
      },
    ]);

    if (inspect.outcome !== "succeeded") {
      const bad = firstBad(inspect.steps);
      return finalize({
        operation: op,
        target,
        steps: [...inspect.steps, ...skipped([...plannedMutations, ...plannedReads], bad?.status ?? "failed")],
        verification: verify ? unavailable("the request stopped before anything was sent") : notRequested(),
        mutated: false,
        noop: false,
        extra: { previous, command, sequenceName: seq.name },
      });
    }

    const alreadyAssigned = isSameObject(previous.object, seq);
    const occupiedByOther = !previous.empty && !alreadyAssigned;

    if (occupiedByOther && !replace) {
      const refusal: StepResult = {
        name: "assign",
        status: "failed",
        error: `${ref} already holds ${describeAssigned(previous.object)}; pass replace: true to replace it. Nothing was sent.`,
      };
      return finalize({
        operation: op,
        target,
        steps: [...inspect.steps, refusal, ...skipped([...plannedMutations.slice(1), ...plannedReads], "refused")],
        verification: verify ? unavailable("the request was refused before anything was sent") : notRequested(),
        mutated: false,
        noop: false,
        extra: { previous, alreadyAssigned: false, command, sequenceName: seq.name },
      });
    }

    // Phase 2: mutations. The assign command is skipped when the executor already holds this sequence.
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    if (!alreadyAssigned) plan.push({ name: "assign", run: () => commandStep(bridge, "assign", command, t) });
    if (label !== undefined) plan.push({ name: "label", run: labelStep(bridge, ref, label, t) });
    const mutation = plan.length ? await runSteps(plan) : { steps: [] as StepResult[], outcome: "succeeded" as const };
    const mutated = mutation.steps.some((s) => s.status !== "skipped");
    const labelled = mutation.steps.some((s) => s.name === "label" && s.status !== "skipped");
    const warnings: string[] = [];
    if (occupiedByOther) warnings.push(`replaced ${describeAssigned(previous.object)} on ${ref}`);
    if (labelled) warnings.push(`the label renames ${sourceRef} itself (an executor shows its assigned object's name); the new name appears everywhere that object does`);

    // Phase 3: read-back whenever something may have changed (or for a verified no-op).
    let verification: Verification = verify ? unavailable("read-back was not reached") : notRequested();
    let resulting: ExecutorState | null = null;
    let sequenceNameAfter: string | null = null;
    const steps = [...inspect.steps, ...mutation.steps];
    const readBackSteps: StepResult[] = [];
    if (verify) {
      // If the label step did not run, the sequence should still carry its old name.
      const rb = await readBack(bridge, ref, { objectName: labelled && label !== undefined ? label : seq.name ?? "", objectClass: seq.class, objectAddr: seq.addr, label: labelled ? label : undefined }, sourceRef);
      readBackSteps.push(...rb.steps);
      verification = rb.verification;
      resulting = rb.resulting;
      sequenceNameAfter = rb.objectName;
      if (label !== undefined && !labelled) readBackSteps.push(...skipped(["read_back_object"], "skipped"));
    }

    let summary: string | undefined;
    if (alreadyAssigned && !mutated) {
      summary = `${sourceRef} (${JSON.stringify(seq.name)}) is already assigned to ${ref}; no command was sent.${verification.status === "matched" ? " Read-back matched." : verification.status === "mismatched" ? ` Read-back MISMATCHED: ${verification.detail}` : ""}`;
    } else if (alreadyAssigned && mutation.outcome === "succeeded" && verification.status !== "mismatched") {
      summary = `${sourceRef} was already assigned to ${ref}; only the label was applied (renaming the assigned object).${verification.status === "matched" ? " Read-back matched." : ""}`;
    }

    return finalize({
      operation: op,
      target,
      steps,
      verification,
      mutated,
      noop: alreadyAssigned,
      summary,
      readBackSteps,
      warnings,
      extra: {
        previous,
        resulting,
        alreadyAssigned,
        replaced: occupiedByOther && mutated,
        command: alreadyAssigned ? null : command,
        sequenceName: seq.name,
        sourceRef,
        sourceObject: seq,
        ...(label !== undefined ? { sequenceNameAfter } : {}),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_label_executor
// ---------------------------------------------------------------------------

interface LabelArgs {
  page: number;
  executor: number;
  label: string;
  verify?: boolean;
}

export async function labelExecutor(ctx: ToolContext, raw: LabelArgs): Promise<OperationResult> {
  const op = "label_executor";
  const v = new Validator();
  const page = v.check(() => pageNumber("page", raw.page));
  const executor = v.check(() => executorNumber("executor", raw.executor));
  const label = v.check(() => objectName("label", raw.label));
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { page: raw.page, executor: raw.executor, label: raw.label };
  if (dataPoolOf(ctx.bridge) !== undefined) target.data_pool = dataPoolOf(ctx.bridge);
  if (!v.ok || page === undefined || executor === undefined || label === undefined) return validationFailure(op, target, v.errors);

  const ref = executorRef(page, executor);
  target.executorRef = ref;
  const t = ctx.requestTimeoutMs;
  const bridge = ctx.bridge;
  const plannedReads = verify ? ["read_back", "read_back_object"] : [];

  return ctx.mutations.run(async () => {
    let previous: ExecutorState = { empty: true };

    const inspect = await runSteps([
      {
        name: "check_page",
        run: inspectStep(bridge, "check_page", `Page ${page}`, ["Name"], (item) => {
          if (!item) return { name: "check_page", status: "failed", op: "objects", error: `Page ${page} does not exist` };
          return { name: "check_page", status: "succeeded", op: "objects", detail: { name: item.name, addr: item.addr } };
        }),
      },
      {
        name: "inspect_executor",
        run: inspectStep(bridge, "inspect_executor", ref, ["Object", "Name"], (item) => {
          previous = executorState(item);
          if (!item || previous.empty) {
            return { name: "inspect_executor", status: "failed", op: "objects", error: `${ref} is empty: nothing is assigned, so there is nothing to label. Assign something first (gma3_assign_to_executor accepts a label).` };
          }
          return { name: "inspect_executor", status: "succeeded", op: "objects", detail: previous };
        }),
      },
    ]);

    if (inspect.outcome !== "succeeded") {
      const bad = firstBad(inspect.steps);
      return finalize({
        operation: op,
        target,
        steps: [...inspect.steps, ...skipped(["label", ...plannedReads], bad?.status ?? "failed")],
        verification: verify ? unavailable("the request stopped before anything was sent") : notRequested(),
        mutated: false,
        noop: false,
        extra: { previous },
      });
    }

    const objectRef = assignedObjectRef(previous.object);
    const mutation = await runSteps([{ name: "label", run: labelStep(bridge, ref, label, t) }]);
    const mutated = mutation.steps.some((s) => s.status !== "skipped");
    const steps = [...inspect.steps, ...mutation.steps];
    const warnings = [`labelling an executor renames its assigned object (${describeAssigned(previous.object)}); the new name appears everywhere that object does`];
    let verification: Verification = verify ? unavailable("read-back was not reached") : notRequested();
    let resulting: ExecutorState | null = null;
    let assignedObjectName: string | null = null;

    const readBackSteps: StepResult[] = [];
    if (verify) {
      const rb = await readBack(bridge, ref, { objectName: label, objectClass: previous.object?.class, objectAddr: previous.object?.addr, label }, previous.object?.addr ?? objectRef);
      readBackSteps.push(...rb.steps);
      verification = rb.verification;
      resulting = rb.resulting;
      assignedObjectName = rb.objectName;
      if (!objectRef) {
        readBackSteps.push(...skipped(["read_back_object"], "skipped"));
        warnings.push("the assigned object could not be addressed for its own read-back; only the executor's view was verified");
      }
    }

    return finalize({
      operation: op,
      target,
      steps,
      verification,
      mutated,
      noop: false,
      readBackSteps,
      warnings,
      extra: { previous, resulting, assignedObjectRef: objectRef, assignedObjectAddr: previous.object?.addr, assignedObjectName },
    });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EXECUTOR_DESC = "Executor number on that page: 101-190 (keys), 201-290 (faders), 301-390 and 401-490 (knobs), plus the Xkeys 191-198 and 291-298.";
const NAME_DESC = "Names must not contain \\ \" $ & * ? , . ; ^ { } | ~ (the console strips them); leading/trailing spaces are trimmed.";
const assignArgumentSchema = z.object({
  sequence: z.number().optional(), object: z.string().optional(), page: z.number().optional(), executor: z.number().optional(),
  replace: z.boolean().optional(), label: z.string().optional(), verify: z.boolean().optional(),
});

export const registerExecutorTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_assign_to_executor",
    {
      title: "Assign an object to an executor",
      description:
        "Assign a sequence or macro to an executor on an explicit page: give sequence for compatibility or object (Sequence <n>, Macro <n>, optionally DataPool <n>). Sends 'Assign <object> At Page <p>.<e>'. " +
        "Before sending anything it checks read-only that the sequence and the page exist and what the executor currently holds; " +
        "an executor holding a different object is only replaced with replace: true (otherwise the call fails with the previous assignment in the result), " +
        "and an executor that already holds this sequence is left alone (alreadyAssigned: true, no command sent). " +
        "Optional label: sends 'Label Page <p>.<e> \"<label>\"' after assigning. On grandMA3 an executor has no label of its own: it shows its assigned object's name, so this RENAMES THE ASSIGNED OBJECT itself, everywhere it appears (pools, other executors). " +
        "If labelling fails after the assignment the outcome is partial. " +
        "Does not change the fixture selection or the programmer and never sends Go/On/Off/Toggle or any playback keyword; whether the console changes the selected sequence on assignment is not controlled by this tool. " +
        "verify (default true) reads the executor back and compares the assigned object by address, name and class and, when a label was given, the executor's displayed name and the object's own Name; executor configuration, fader/key functions and playback state are NOT verified. " +
        "Mutations from this server are serialised, but another operator or client can still change the executor between the inspection and the assignment. " +
        "Batch form (assignments): each target executor is checked to be empty or to hold that sequence already, unless replace is given for that item (or for the whole call); a target listed twice is refused. " +
        BATCH_NOTE,
      inputSchema: {
        ...dataPoolShape,
        sequence: z.number().optional().describe("Sequence number to assign (must exist). Give sequence or object; omit single-source fields with assignments."),
        object: z.string().optional().describe("One Sequence or Macro reference by number, optionally DataPool <n> qualified. Give object or sequence, never both. Must exist."),
        page: z.number().optional().describe("Executor page number (1-9999). The page must already exist; the tool does not create pages. Required unless assignments is given (it may then be a default for every item)."),
        executor: z.number().optional().describe(`${EXECUTOR_DESC} Required unless assignments is given.`),
        replace: z.boolean().optional().describe("Replace an executor that holds a different object (default false: fail and report the previous assignment)."),
        label: z.string().optional().describe(`Optional new name for the assigned sequence (an executor displays its assigned object's name). ${NAME_DESC}`),
        verify: z.boolean().optional().describe("Read the executor (and the sequence, when labelled) back and compare (default true)."),
        assignments: z
          .array(z.object({ sequence: z.number().optional(), object: z.string().optional(), page: z.number().optional(), executor: z.number(), replace: z.boolean().optional(), label: z.string().optional() }))
          .optional()
          .describe("Batch form: several assignments, each {sequence, page, executor, replace, label}; page may be given once for all."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        args.assignments !== undefined
          ? runBatchCall(args, {
              ctx: inDataPool(ctx, args),
              operation: "assign_to_executor",
              listKey: "assignments",
              identityKeys: ["sequence", "object", "executor", "label"],
              label: (it) => `${it.object === undefined ? `Sequence ${String(it.sequence)}` : String(it.object)} -> Page ${String(it.page)}.${String(it.executor)}`,
              key: (it) => `Page ${String(it.page)}.${String(it.executor)}`,
              check: (items) => duplicates(items.map((it) => `Page ${String(it.page)}.${String(it.executor)}`)).map((x) => `${x} is a target more than once in assignments`),
              run: (it, c) => assignToExecutor(c, assignArgumentSchema.parse(it)),
            })
          : assignToExecutor(inDataPool(ctx, args), args),
      ),
  );

  server.registerTool(
    "gma3_label_executor",
    {
      title: "Label an executor (renames its assigned object)",
      description:
        "Label the object assigned to the executor at Page <p>.<e>: sends 'Label Page <p>.<e> \"<name>\"'. On grandMA3 2.5.1 an executor has no label of its own and always shows its assigned object's name, so this RENAMES THE ASSIGNED SEQUENCE (or other object) everywhere it appears: in its pool and on every other executor it is assigned to. " +
        "Fails before sending anything when the page does not exist or the executor is empty (nothing to label). " +
        "Does not change the selection or the programmer and never sends a playback keyword. " +
        "verify (default true) reads back the executor's displayed name and assigned object and the assigned object's own Name; nothing else is verified. " +
        "Mutations from this server are serialised, but not isolated from other operators or clients.",
      inputSchema: {
        ...dataPoolShape,
        page: z.number().describe("Executor page number (1-9999); the page must exist."),
        executor: z.number().describe(EXECUTOR_DESC),
        label: z.string().describe(`The new name for the assigned object. ${NAME_DESC}`),
        verify: z.boolean().optional().describe("Read the executor and its assigned object back and compare (default true)."),
      },
    },
    async (args) => operation(() => labelExecutor(inDataPool(ctx, args), args)),
  );
};
