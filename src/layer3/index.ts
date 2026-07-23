// Layer 3 is now a projection over the unified engine (Phase 1). The
// integrator module is gone; T/I/OE simulation is `simulate` over `@/sim`.
export { simulate } from "./simulate";
export {
  DEFAULT_INTEGRATOR_OPTIONS,
  type IntegratorOptions,
  type Intervention,
  type SimulateOptions,
  type SimulationResult,
  type Trajectory,
} from "./simulate";
// Re-export engine primitives the layers consume (state types, stepping, T/I/OE).
export {
  initialState,
  run,
  step,
  impulse,
  setValue,
  deriveTioe,
  totalMass,
  equilibrium,
  type EngineOptions,
  type IntegratorMethod,
  type SimState,
  type TioeSnapshot,
} from "@/sim";
export { sparkline } from "./sparkline";
export type { SparklineOptions, SparklinePoint, SparklineSeries } from "./sparkline";
export { Layer3Panel } from "./panel";
