/**
 * AsyncLocalStorage-backed execution context for the producer.
 *
 * The producer's runOneGem wraps each tool invocation in a context
 * carrying (jobId, slot_id, gem_id). Tools (yt-capture, image_gen,
 * video_compose, etc.) can then call `emitToolCall(step, payload)`
 * at internal boundaries to drop tool_call nodes into the execution
 * graph — without threading any explicit context object through
 * their function signatures.
 *
 * Why ALS: keeps tool authors honest. They don't need to know about
 * the producer's bookkeeping; if they're running inside a gem, their
 * emits land in the graph; outside, they no-op silently.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { upsertNode, addEdge, nodeKey } from './exec-graph';

export interface ExecCtx {
  jobId: number;
  slot_id: string;
  gem_id: string;
  /** Monotonic counter for per-gem tool_call indices. Each emit
   *  increments it to produce a stable node_key. */
  callCounter: { n: number };
}

const als = new AsyncLocalStorage<ExecCtx>();

/** Run a callback inside an execution context. Used by the producer's
 *  runOneGem to wrap a tool invocation. */
export function runWithContext<T>(ctx: Omit<ExecCtx, 'callCounter'>, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...ctx, callCounter: { n: 0 } }, fn);
}

/** Emit a tool_call node into the graph. Safe to call from anywhere —
 *  outside a producer gem (e.g. screen-capture admin endpoint hitting
 *  yt-capture directly) the call no-ops. */
export async function emitToolCall(step: string, payload?: Record<string, unknown>): Promise<void> {
  const ctx = als.getStore();
  if (!ctx) return;
  const idx = ++ctx.callCounter.n;
  const key = nodeKey.toolCall(ctx.slot_id, ctx.gem_id, idx);
  await upsertNode({
    jobId: ctx.jobId,
    nodeKey: key,
    nodeType: 'tool_call',
    label: step.slice(0, 80),
    status: 'done',
    payload: { step, ...(payload ?? {}) },
  });
  // Edge from the parent gem to this tool_call so the GUI can render the
  // nesting (gem → tool_call sequence).
  await addEdge(ctx.jobId, nodeKey.gem(ctx.slot_id, ctx.gem_id), key, 'sequence');
}

/** Variant that scopes a tool_call to an async block — emits a 'running'
 *  node at the start and updates it to 'done' or 'failed' on completion.
 *  Use for steps where you care about duration / failure attribution. */
export async function withToolCall<T>(step: string, fn: () => Promise<T>, payload?: Record<string, unknown>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn();
  const idx = ++ctx.callCounter.n;
  const key = nodeKey.toolCall(ctx.slot_id, ctx.gem_id, idx);
  await upsertNode({
    jobId: ctx.jobId,
    nodeKey: key,
    nodeType: 'tool_call',
    label: step.slice(0, 80),
    status: 'running',
    payload: { step, ...(payload ?? {}) },
  });
  await addEdge(ctx.jobId, nodeKey.gem(ctx.slot_id, ctx.gem_id), key, 'sequence');
  const t0 = Date.now();
  try {
    const out = await fn();
    await upsertNode({
      jobId: ctx.jobId, nodeKey: key, nodeType: 'tool_call',
      label: step.slice(0, 80), status: 'done',
      payload: { step, elapsed_ms: Date.now() - t0 },
    });
    return out;
  } catch (e) {
    await upsertNode({
      jobId: ctx.jobId, nodeKey: key, nodeType: 'tool_call',
      label: step.slice(0, 80), status: 'failed',
      payload: { step, elapsed_ms: Date.now() - t0, error: (e as Error).message.slice(0, 200) },
    });
    throw e;
  }
}
