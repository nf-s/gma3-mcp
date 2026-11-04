/**
 * Opt-in executor authoring qualification on a disposable show:
 * GMA3_LIVE=1 node --import tsx --test test/live/executor-authoring.live.ts
 *
 * Creates Page 91 only when absent, Sequence/Macro/Configuration 970 only when absent, assigns them
 * to Page 91.201 and 91.205, configures functions/custom commands and a 2x2 executor, then
 * deletes only those created objects. Requires a confirmed empty programmer and empty target
 * cells (201-205, 301-305). Sends no playback, executor press, macro run or SaveShow command.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import { exists } from "../../src/tools/common.ts";
import { registerExecutorTools } from "../../src/tools/executors.ts";
import { registerPlaybackTools } from "../../src/tools/playback.ts";

const PAGE = 91;
const NUMBER = 970;
const resultSchema = z.object({ outcome: z.string(), verification: z.object({ status: z.string() }), summary: z.string(), alreadyAssigned: z.boolean().optional(), affectedExecutors: z.array(z.object({ data_pool: z.number().optional(), page: z.number(), executor: z.number() })).optional() });

liveTest("executor authoring: macro assignment, custom commands, MA encoder functions and collision checks", async (t, bridge) => {
  for (const ref of [`Sequence ${NUMBER}`, `Macro ${NUMBER}`, `Configuration ${NUMBER}`]) assert.equal((await exists(bridge, ref)).exists, false, `${ref} must be free`);
  const page = await exists(bridge, `Page ${PAGE}`);
  assert.notEqual(page.exists, "unknown");
  if (page.exists) for (const executor of [201, 202, 203, 204, 205, 301, 302, 303, 304, 305]) assert.equal((await exists(bridge, `Page ${PAGE}.${executor}`)).exists, false, `Page ${PAGE}.${executor} must be free`);

  const programmer = z.object({ rows: z.array(z.unknown()), coverage: z.object({ complete: z.boolean() }), stats: z.object({ channelErrors: z.number(), channelsWithData: z.number() }), limitations: z.array(z.unknown()) }).safeParse(await bridge.request("programmer", {}));
  if (!programmer.success || !programmer.data.coverage.complete || programmer.data.rows.length || programmer.data.stats.channelErrors || programmer.data.stats.channelsWithData || programmer.data.limitations.length) {
    t.skip("the programmer must be confirmed empty before storing the disposable sequence");
    return;
  }

  const ctx = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = new Map([...captureTools(registerExecutorTools, ctx), ...captureTools(registerPlaybackTools, ctx)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    const response = await tool.call(args);
    const result = resultSchema.parse(JSON.parse(response.content.map((part) => part.text).join("\n")));
    return { result, isError: Boolean(response.isError) };
  };
  let madePage = false;
  let madeSequence = false;
  let madeMacro = false;
  let madeConfiguration = false;
  let sequenceAssigned = false;
  let macroAssigned = false;
  t.after(async () => {
    if (sequenceAssigned) await cmd(`Delete Page ${PAGE}.201 /NoConfirmation`);
    if (macroAssigned) await cmd(`Delete Page ${PAGE}.205 /NoConfirmation`);
    if (madeSequence) await cmd(`Delete Sequence ${NUMBER} /NoConfirmation`);
    if (madeMacro) await cmd(`Delete Macro ${NUMBER} /NoConfirmation`);
    if (madeConfiguration) await cmd(`Delete Configuration ${NUMBER} /NoConfirmation`);
    if (madePage) await cmd(`Delete Page ${PAGE} /NoConfirmation`);
    if (madeSequence) assert.equal((await exists(bridge, `Sequence ${NUMBER}`)).exists, false);
    if (madeMacro) assert.equal((await exists(bridge, `Macro ${NUMBER}`)).exists, false);
    if (madeConfiguration) assert.equal((await exists(bridge, `Configuration ${NUMBER}`)).exists, false);
  });
  if (!page.exists) {
    assert.equal(await cmd(`Store Page ${PAGE} /NoConfirmation`), "OK");
    madePage = true;
  }
  assert.equal(await cmd(`Store Sequence ${NUMBER} Cue 1 /NoConfirmation`), "OK");
  madeSequence = true;
  assert.equal(await cmd(`Store Macro ${NUMBER} /NoConfirmation`), "OK");
  madeMacro = true;
  sequenceAssigned = true;
  const sequence = await call("gma3_assign_to_executor", { sequence: NUMBER, page: PAGE, executor: 201 });
  assert.equal(sequence.isError, false, sequence.result.summary);
  assert.equal(sequence.result.verification.status, "matched");
  macroAssigned = true;
  const macro = await call("gma3_assign_to_executor", { object: `Macro ${NUMBER}`, page: PAGE, executor: 205 });
  assert.equal(macro.isError, false, macro.result.summary);
  assert.equal(macro.result.verification.status, "matched");
  const duplicate = await call("gma3_assign_to_executor", { object: `Macro ${NUMBER}`, page: PAGE, executor: 205 });
  assert.equal(duplicate.result.alreadyAssigned, true);
  const macroSettings = await call("gma3_configure_executor", { page: PAGE, executor: 205, key_press: "Call", fader: "Empty" });
  assert.equal(macroSettings.isError, false, macroSettings.result.summary);
  assert.equal(macroSettings.result.verification.status, "matched");
  const configured = await call("gma3_configure_executor", {
    page: PAGE, executor: 201, width: 2, height: 2, ma_encoder: "Speed",
    custom_commands: { key_press: { command: 'Echo "MCP  authoring"', enabled: true, add_executor: false } },
  });
  assert.equal(configured.isError, false, configured.result.summary);
  assert.equal(configured.result.verification.status, "matched");
  const discrete = await call("gma3_configure_executor", { page: PAGE, executor: 201, ma_encoder_left: "Go-", ma_encoder_right: "Go+" });
  assert.equal(discrete.isError, false, discrete.result.summary);
  assert.equal(discrete.result.verification.status, "matched");
  const collision = await call("gma3_configure_executor", { page: PAGE, executor: 201, width: 5 });
  assert.equal(collision.isError, true);
  assert.match(collision.result.summary, /overlaps occupied cells/);
  const proxy = await call("gma3_assign_to_executor", { object: `Macro ${NUMBER}`, page: PAGE, executor: 301, replace: true });
  assert.equal(proxy.isError, true);
  assert.match(proxy.result.summary, /covered by an expanded executor/);
  assert.equal(await cmd(`Store Configuration ${NUMBER} /NoConfirmation`), "OK");
  madeConfiguration = true;
  const loaded = await call("gma3_executor_configuration", { action: "load", configuration: NUMBER, page: PAGE, executor: 201 });
  assert.equal(loaded.isError, false, loaded.result.summary);
  assert.equal(loaded.result.verification.status, "matched");
  const expanded = await call("gma3_configure_executor", { page: PAGE, executor: 201, width: 2, height: 2, key_press: "Go+" });
  assert.equal(expanded.isError, false, expanded.result.summary);
  const plan = await call("gma3_executor_configuration", { action: "recast", configuration: NUMBER });
  assert.equal(plan.isError, false, plan.result.summary);
  assert.ok(plan.result.affectedExecutors);
  assert.equal(plan.result.affectedExecutors.length, 1);
  const recastTargets = plan.result.affectedExecutors.map((item) => {
    const pool = item.data_pool;
    assert.ok(pool !== undefined, "recast plan must qualify every affected executor's data pool");
    return { data_pool: pool, page: item.page, executor: item.executor };
  });
  const recast = await call("gma3_executor_configuration", { action: "recast", configuration: NUMBER, apply: true, executors: recastTargets });
  assert.equal(recast.isError, false, recast.result.summary);
  assert.equal(recast.result.verification.status, "matched");
});
