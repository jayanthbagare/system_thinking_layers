export { DEFAULT_WEIGHTS, scoreGraph, topConstraints } from "./scoring";
export type { ScoreResult, ScoredNode, SignalBreakdown, SignalId, Weights } from "./scoring";
export { Layer2Panel } from "./panel";
export type { SidePanelOptions } from "./panel";
// Phase 5 — constraint migration: predicted vs observed.
export {
  predictedConstraint,
  observedConstraint,
  persistIntervention,
  recordMigrationStep,
  detectCycle,
  stepSummary,
  disagreementMessage,
  type ConstraintIdentity,
  type ObservedConstraintResult,
  type MigrationStep,
  type MigrationTrail,
  type CycleDetection,
} from "./migration";
