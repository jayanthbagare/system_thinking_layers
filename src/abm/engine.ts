/**
 * Phase 5 — Agent-Based Model engine (spec §5).
 *
 * A pure, framework-agnostic ABM engine. Agents are simple state machines with
 * a fixed, enumerated rule vocabulary — NO eval/Function on user input (per
 * PLAN §4.3 security). The aggregate of an agent state variable over time is
 * the macro time-series that `validate.ts` compares against the bound node's
 * loop polarity/delay.
 *
 * Rules (v1 vocabulary, per spec §5):
 *   - reorder_policy: agents replenish backlog; aggregate amplifies
 *     (reinforcing).
 *   - capacity_threshold: agents produce when below threshold; aggregate
 *     converges (balancing).
 *   - info_passing_delay: agents pass a value to neighbors after `delay` steps;
 *     aggregate shows lagged propagation.
 *
 * Topologies: well-mixed (every agent sees every other), lattice (ring), or
 * network (fixed random graph from the seed).
 *
 * Determinism: a mulberry32 PRNG seeded by `seed` drives all stochasticity.
 * Same (population, seed, steps) -> identical aggregate series.
 *
 * Architecture rule: this module holds no state. `runAbm` is a pure function.
 */

export type RuleKind = "reorder_policy" | "capacity_threshold" | "info_passing_delay";
export type Topology = "well_mixed" | "lattice" | "network";

export interface RuleParams {
  /** Sensitivity / gain for reorder_policy; threshold for capacity_threshold. */
  sensitivity: number;
  /** Delay steps for info_passing_delay; also perturbs reorder amplification. */
  delay: number;
}

export interface AgentPopulation {
  boundNode: string;
  agentCount: number;
  rule: RuleKind;
  topology: Topology;
  params: RuleParams;
  seed: number;
}

export interface AbmResult {
  /** Aggregate of the bound state variable, one value per step. */
  series: number[];
  /** Steps actually run. */
  steps: number;
  /** The population that produced this result. */
  population: AgentPopulation;
}

/** Per-agent state. Kept minimal; rules read/write these fields. */
interface AgentState {
  /** Primary state variable (backlog for reorder, level for capacity, value for info). */
  x: number;
  /** Secondary state (e.g. incoming flow buffer). */
  buffer: number;
  /** History queue for delayed info passing. */
  history: number[];
}

/**
 * Run the ABM. Pure: same (population, steps) -> identical series.
 *
 * The engine is O(steps * agentCount * degree). For 10k agents / 500 steps on
 * well-mixed (degree = agentCount) that's 5M ops — fast enough to run in a Web
 * Worker well under the 5s budget (PLAN §4.4).
 */
export function runAbm(pop: AgentPopulation, steps: number): AbmResult {
  const rng = mulberry32(pop.seed);
  const agents = initAgents(pop, rng);
  const neighbors = buildTopology(pop, rng);
  const series: number[] = [];

  for (let t = 0; t < steps; t++) {
    stepAgents(pop, agents, neighbors, rng, t);
    series.push(aggregate(agents));
  }

  return { series, steps, population: pop };
}

// --- initialization -----------------------------------------------------

function initAgents(pop: AgentPopulation, rng: () => number): AgentState[] {
  const agents: AgentState[] = [];
  for (let i = 0; i < pop.agentCount; i++) {
    agents.push({
      x: initialStateForRule(pop.rule, rng),
      buffer: 0,
      history: [],
    });
  }
  return agents;
}

function initialStateForRule(rule: RuleKind, rng: () => number): number {
  // Small random perturbation around 1.0 so the system isn't perfectly
  // symmetric (which would mask reinforcing behavior).
  const jitter = 0.9 + rng() * 0.2;
  switch (rule) {
    case "reorder_policy":
      return 1.0 * jitter;
    case "capacity_threshold":
      return popAround(0.5, rng);
    case "info_passing_delay":
      return 1.0 * jitter;
  }
}

function popAround(center: number, rng: () => number): number {
  return center + (rng() - 0.5) * 0.2;
}

// --- topology -----------------------------------------------------------

function buildTopology(
  pop: AgentPopulation,
  rng: () => number,
): number[][] {
  const n = pop.agentCount;
  switch (pop.topology) {
    case "well_mixed":
      // Every agent sees every other (degree = n-1). Expensive for large n;
      // the rule update uses a global aggregate instead of per-pair iteration.
      return [];
    case "lattice": {
      const adj: number[][] = [];
      for (let i = 0; i < n; i++) {
        adj.push([(i - 1 + n) % n, (i + 1) % n]);
      }
      return adj;
    }
    case "network": {
      // Fixed random graph: each agent connects to 3 random others.
      const adj: number[][] = [];
      for (let i = 0; i < n; i++) {
        const set = new Set<number>();
        while (set.size < 3) {
          const j = Math.floor(rng() * n);
          if (j !== i) set.add(j);
        }
        adj.push([...set]);
      }
      return adj;
    }
  }
}

// --- per-step update ----------------------------------------------------

function stepAgents(
  pop: AgentPopulation,
  agents: AgentState[],
  neighbors: number[][],
  rng: () => number,
  _t: number,
): void {
  switch (pop.rule) {
    case "reorder_policy":
      stepReorder(pop, agents, rng);
      break;
    case "capacity_threshold":
      stepCapacity(pop, agents, neighbors, rng);
      break;
    case "info_passing_delay":
      stepInfoPassing(pop, agents, neighbors);
      break;
  }
}

/**
 * Reorder policy: each agent orders `sensitivity * backlog`. Backlog grows
 * based on the global mean order (well-mixed coupling). This amplifies — a
 * classic bullwhip reinforcing dynamic.
 */
function stepReorder(pop: AgentPopulation, agents: AgentState[], rng: () => number): void {
  const mean = aggregate(agents);
  const k = pop.params.sensitivity;
  for (const a of agents) {
    const order = k * a.x;
    // Backlog grows by the mean order (coupling) and shrinks by own fulfillment.
    const noise = 1 + (rng() - 0.5) * 0.02;
    a.buffer = a.x + mean * 0.1 - order * 0.05;
    a.x = a.buffer * noise;
  }
}

/**
 * Capacity threshold: agents below threshold produce (increase level), agents
 * above consume (decrease). Coupled to neighbors' mean. This converges — a
 * balancing dynamic.
 */
function stepCapacity(
  pop: AgentPopulation,
  agents: AgentState[],
  neighbors: number[][],
  rng: () => number,
): void {
  const threshold = pop.params.sensitivity;
  const coupling = pop.params.delay > 0 ? 0.1 : 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    let neighborMean = a.x;
    if (neighbors.length > 0 && neighbors[i].length > 0) {
      let sum = 0;
      for (const j of neighbors[i]) sum += agents[j].x;
      neighborMean = sum / neighbors[i].length;
    }
    const produce = a.x < threshold ? 1 : -1;
    const noise = 1 + (rng() - 0.5) * 0.05;
    a.x = (a.x + produce * 0.1 + coupling * (neighborMean - a.x)) * noise;
    // Clamp to prevent runaway.
    a.x = Math.max(0, Math.min(2, a.x));
  }
}

/**
 * Info-passing delay: each agent holds a value and passes it to neighbors after
 * `delay` steps (via a history queue). The aggregate shows lagged propagation.
 */
function stepInfoPassing(
  pop: AgentPopulation,
  agents: AgentState[],
  neighbors: number[][],
): void {
  const delay = Math.max(1, Math.round(pop.params.delay));
  // Snapshot current values.
  const current = agents.map((a) => a.x);
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    a.history.push(current[i]);
    if (a.history.length > delay) a.history.shift();
    // The value an agent receives from neighbors is the neighbors' value
    // `delay` steps ago.
    if (neighbors.length > 0 && neighbors[i].length > 0) {
      let sum = 0;
      for (const j of neighbors[i]) {
        const hj = agents[j].history;
        sum += hj.length > 0 ? hj[hj.length - 1] : current[j];
      }
      const neighborMean = sum / neighbors[i].length;
      a.x = 0.7 * current[i] + 0.3 * neighborMean;
    }
  }
}

// --- helpers ------------------------------------------------------------

function aggregate(agents: AgentState[]): number {
  let sum = 0;
  for (const a of agents) sum += a.x;
  return agents.length > 0 ? sum / agents.length : 0;
}

/** Mulberry32 PRNG — fast, deterministic, sufficient for ABM. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
