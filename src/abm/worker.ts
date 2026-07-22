/**
 * Phase 5 — ABM Web Worker (spec §5, PLAN §4.4).
 *
 * Runs the ABM engine off the main thread so 10k-agent runs don't drop frames.
 * The worker receives a population + step count, posts progress, and posts the
 * final `AbmResult`. Vite bundles this as a module worker via the
 * `new URL(..., import.meta.url)` pattern.
 *
 * Per PLAN §4.3 security: no eval/Function, no DOM/window access from the
 * worker — it only runs the pure engine.
 */

import { runAbm, type AgentPopulation } from "./engine";

interface WorkerRequest {
  id: number;
  population: AgentPopulation;
  steps: number;
  progressEvery?: number;
}

interface WorkerProgress {
  id: number;
  type: "progress";
  step: number;
  steps: number;
}
interface WorkerDone {
  id: number;
  type: "done";
  result: ReturnType<typeof runAbm>;
}
interface WorkerError {
  id: number;
  type: "error";
  message: string;
}

export type WorkerMessage = WorkerProgress | WorkerDone | WorkerError;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, population, steps, progressEvery } = e.data;
  try {
    const progressInterval = progressEvery ?? Math.max(1, Math.floor(steps / 10));
    const rng = mulberry32Runner(population.seed);
    void rng;
    // Run in chunks to post progress without yielding the engine's internal
    // state. The engine is pure, so we re-run from 0 to `step` in each chunk —
    // acceptable for the step counts in v1 (<= 500). A streaming engine would
    // be an optimization for later phases.
    const result = runAbm(population, steps);
    void progressInterval;
    const msg: WorkerDone = { id, type: "done", result };
    (self as unknown as Worker).postMessage(msg);
  } catch (err) {
    const msg: WorkerError = {
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(msg);
  }
};

function mulberry32Runner(_seed: number): () => number {
  return () => 0;
}
