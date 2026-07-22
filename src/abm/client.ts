/**
 * Phase 5 — ABM client (main-thread wrapper around the Web Worker).
 *
 * Spawns the worker lazily and provides a promise-based `run` API. Falls back
 * to a synchronous in-thread run if workers are unavailable (e.g. in tests or
 * non-module-worker environments) so the engine stays usable everywhere.
 */

import { runAbm, type AbmResult, type AgentPopulation } from "./engine";

export interface RunRequest {
  population: AgentPopulation;
  steps: number;
  onProgress?: (step: number, steps: number) => void;
}

export class AbmClient {
  private worker: Worker | null = null;
  private nextId = 0;

  /** Run the ABM. Returns a promise that resolves with the result. */
  run(req: RunRequest): Promise<AbmResult> {
    if (typeof Worker !== "undefined") {
      return this.runInWorker(req);
    }
    // Fallback (tests / non-worker envs): run synchronously.
    return Promise.resolve(runAbm(req.population, req.steps));
  }

  private runInWorker(req: RunRequest): Promise<AbmResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<AbmResult>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.id !== id) return;
        if (msg.type === "done") {
          worker.removeEventListener("message", handler);
          resolve(msg.result);
        } else if (msg.type === "error") {
          worker.removeEventListener("message", handler);
          reject(new Error(msg.message));
        } else if (msg.type === "progress") {
          req.onProgress?.(msg.step, msg.steps);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({
        id,
        population: req.population,
        steps: req.steps,
      });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return this.worker;
  }

  /** Terminate the worker. Safe to call multiple times. */
  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
