/**
 * Layer 1 CLD renderer (spec §2).
 *
 * A self-contained D3 view over a single `Graph`. It owns a force-directed
 * simulation and renders nodes, edges, loops, and delay marks to an SVG root.
 *
 * Architecture rule: this module holds NO parallel state. Every visual is
 * derived from the `Graph` passed in. The only mutable thing here is the D3
 * simulation, whose transient node positions are not part of the model —
 * manual pins (`Node.pin`) are the only positions persisted back to `Graph`.
 *
 * Responsibilities:
 *   - force-directed layout with optional manual pins (Node.pin),
 *   - arrowheads on directed edges,
 *   - polarity symbols at edge midpoints,
 *   - double-hash + magnitude badge on delayed edges,
 *   - R1/B1... loop labels at loop centroids,
 *   - hover/select highlight that isolates a single loop's edges/nodes.
 */

import { select, type Selection } from "d3-selection";
import { forceSimulation, forceLink, forceManyBody, forceCenter, type Simulation } from "d3-force";
import { drag } from "d3-drag";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import type { Edge, Graph, Loop } from "@/model/types";
import { deriveLoops, type DerivedLoops } from "@/graph/loops";
import {
  arrowHead,
  delayBadge,
  delayBadgePosition,
  delayHashMarksDouble,
  edgeGeometry,
  hasDelay,
  heatColor,
  heatRadius,
  loopCentroid,
  loopLabel,
  polaritySymbol,
  shortenToCircleBounds,
  valueColor,
  valueRadiusFraction,
  type Point,
} from "./layout";
import { createEngine, degreesOfFreedom, equilibrium, type Engine, type EngineOptions } from "@/sim";
import { sparkline, type SparklineSeries } from "@/layer3";
import { openEditModal, type NodeEditPatch } from "./editModal";

/** A node as consumed by the simulation — model node + transient layout state. */
export interface SimNode {
  id: string;
  label: string;
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
  pinned: boolean;
}

/** Phase 5 migration arc: a dashed path from the previous constraint to the new. */
export interface MigrationArc {
  from: string;
  to: string;
  /** 0..1, 1 = most recent (full opacity). Older arcs fade. */
  recency: number;
}

/** An edge as consumed by the simulation link force. */
export interface SimEdge {
  id: string;
  source: SimNode;
  target: SimNode;
  polarity: "+" | "-";
  delayType: string;
  delayMagnitude: number;
  strength: number;
}

const NODE_RADIUS = 22;
const ARROW_SIZE = 12; // chevron wing length (px) — loopy-style prominent head
const POLARITY_BADGE_R = 11; // radius of the polarity badge at edge midpoint
const NUDGE_ARROW_OFFSET = 12; // distance of the up/down nudge arrows from the node center
const ANIM_DT = 0.1; // model-time step per animation frame (the engine's stride)
const ANIM_INTEGRATOR: EngineOptions["integrator"] = "rk4";
/** A nudge is 10% of the node's operating-point scale, so it is visible relative
 * to the node's own magnitude regardless of units. */
const NUDGE_FRACTION = 0.1;
/** After a nudge the live animation runs in slow motion so the impulse is
 * watchable as it propagates, easing back to full speed over this window. */
const NUDGE_SLOW_MS = 1600;
/** Floor of the post-nudge time-scale (the deepest slow-down). The actual depth
 * is set proportionally to the nudge's fraction of the node's operating scale,
 * so a standard 10% nudge reaches this floor; bigger relative nudges stay
 * slower for longer. */
const NUDGE_SLOW_FLOOR = 0.1;
/** Wall-clock time for the nudge pulse to travel one edge. Decoupled from the
 * engine so the dot moves smoothly every frame (the engine steps in slow
 * motion would otherwise make it stutter), and so it reads as a single
 * traveling dot rather than the many static delay-pipeline dots. */
const NUDGE_PULSE_MS = 700;
/** Wall-clock lifetime of the nudge "ping" ring on the node. Decoupled from the
 * engine so the ring plays even on undelayed graphs and flow nodes, where the
 * impulse itself has no persistent visual. */
const NUDGE_RING_MS = 650;
const HIGHLIGHTED_CLASS = "is-highlighted";
const DIMMED_CLASS = "is-dimmed";

export interface RendererOptions {
  width: number;
  height: number;
  /**
   * Optional host element for a live "node monitor" sparkline that plots the
   * last-nudged node's value over time as the loopy animation runs. The
   * renderer owns this view (it owns the loopy state); passing a host keeps
   * it a Layer 1 view, not parallel model state.
   */
  monitorHost?: HTMLElement;
  /** Highlight a loop when the user hovers/selects it. */
  onLoopHover?: (loop: Loop | null) => void;
  /** Persist a manual pin onto the Graph's node. */
  onPin?: (nodeId: string, pin: Point | null) => void;
  /**
   * A node's up/down-arrow nudge was clicked. The up arrow nudges the node's
   * value up; the down arrow nudges it down. Both call `engine.impulse` — the
   * same call Layer 3 uses for an intervention — so a canvas nudge and an
   * equivalent L3 Δ drive the same engine and produce the same trajectory.
   * `direction` is +1 for up, -1 for down; used to drive the Layer 3
   * intervention sign so the sparklines re-simulate from the canvas nudge.
   * The live animation is a view over the engine and never writes to `Graph`;
   * this callback is the only outward channel.
   */
  onNudge?: (nodeId: string, direction: number) => void;
  /**
   * The user shift-clicked a node to open the edit modal (spec §2: edit mode).
   * The renderer builds the modal from the node's current properties and emits
   * the validated patch here; the host (main.ts) applies it to the in-memory
   * `Graph` (single source of truth) and writes the result back to YAML. The
   * renderer itself never mutates `Graph` — it only reads the node to
   * populate the form and re-renders after the host has applied the patch.
   */
  onEditNode?: (nodeId: string, patch: NodeEditPatch) => void;
  /**
   * Called after each animation step, with the current DoF count. Used by the
   * play bar to surface "Degrees of freedom: N of M" — visible in every layer.
   */
  onStep?: (dof: number, total: number) => void;
}

export class Layer1Renderer {
  private readonly svg: Selection<SVGSVGElement, unknown, null, unknown>;
  private readonly root: Selection<SVGGElement, unknown, null, unknown>;
  private readonly linkLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly badgeLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly nodeLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly labelLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly nudgeLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly migrationLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

  private graph: Graph | null = null;
  private derived: DerivedLoops = { loops: [], idByKey: new Map() };
  private sim: Simulation<SimNode, undefined> | null = null;
  private simNodes: SimNode[] = [];
  private simEdges: SimEdge[] = [];
  private activeLoopId: string | null = null;
  /** Layer 2 heat overlay: node id -> score in [0,1]. null = no overlay. */
  private heat: Map<string, number> | null = null;
  /** Phase 5 migration arcs: from/to node ids + recency (1 = most recent). */
  private migrationArcs: MigrationArc[] = [];
  private readonly opts: RendererOptions;

  /**
   * The unified simulation engine (Phase 1). L1 is a live view of this engine,
   * running at a slow wall-clock rate and projected onto the canvas. The same
   * engine class backs L3's pre/post runs and L2's sensitivity signal — one
   * model, three readings. The renderer owns one `Engine` instance for the
   * live animation; it never writes to `Graph`.
   */
  private engine: Engine | null = null;
  /** Cached operating point (per-node mean over a long run), used to colour
   * value circles by the sign of deviation. Recomputed on render. */
  private equilib: Record<string, number> | null = null;
  private playing = true;
  private rafId: number | null = null;

  /** Live node monitor: rolling history per node, plus the selected node. */
  private monitorHost: HTMLElement | null = null;
  private trackedNodeId: string | null = null;
  private histories: Map<string, number[]> = new Map();
  private cumulative: Map<string, number> = new Map();
  private monitorBuilt = false;
  private monitorMode: "all" | "single" = "single";
  private monitorMetric: "value" | "cumulative" = "value";
  private static readonly HISTORY_CAP = 200;
  /** Show a sparkline per node when the graph is small enough to fit. */
  private static readonly ALL_NODES_THRESHOLD = 7;

  /** Post-nudge slow motion: the live loop steps the engine at a fractional
   * rate (`timeScale`), accumulated in `stepAcc`. 1 = full speed; <1 = slow.
   * Eased back to 1 over `NUDGE_SLOW_MS` so the nudge's propagation is visible. */
  private timeScale = 1;
  private stepAcc = 0;
  private slowStart = 0;
  private slowStrength = 0;
  /** Transient nudge feedback (pure view state, never written to `Graph`):
   * a decaying "ping" ring on the nudged node, plus a traveling dot on each of
   * its outgoing edges so the impulse's direction is seen even on undelayed
   * graphs where the engine has no delay-queue pulses. */
  private nudgeRing: { nodeId: string; dir: number; start: number } | null = null;
  /** Nudge pulses: wall-clock traveling dots that chain hop-by-hop across the
   * graph. Each pulse records the edge it travels and when it started. When it
   * completes, new pulses are spawned on the outgoing edges of the target node
   * so the impulse visibly propagates through the whole network. */
  private nudgePulses: { edgeId: string; dir: number; start: number }[] = [];
  /** Set of edge ids that already have an active or scheduled pulse this wave,
   * so the same edge is not traversed twice in a single propagation. */
  private nudgePulseVisited: Set<string> = new Set();

  constructor(svg: SVGSVGElement, opts: RendererOptions) {
    this.opts = opts;
    this.monitorHost = opts.monitorHost ?? null;
    this.svg = select(svg);
    this.svg.attr("viewBox", `0 0 ${opts.width} ${opts.height}`);

    // Z-order (back to front): edges → badges → nodes → labels → nudge fx → migration.
    // nudgeLayer is topmost so the traveling pulse and ping ring are never
    // occluded by nodes, edges, or labels.
    this.root = this.svg.append("g").attr("class", "layer1-root");
    this.linkLayer = this.root.append("g").attr("class", "layer1-links");
    this.badgeLayer = this.root.append("g").attr("class", "layer1-badges");
    this.nodeLayer = this.root.append("g").attr("class", "layer1-nodes");
    this.labelLayer = this.root.append("g").attr("class", "layer1-loop-labels");
    this.nudgeLayer = this.root.append("g").attr("class", "layer1-nudge");
    this.migrationLayer = this.root.append("g").attr("class", "layer1-migration");

    this.zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => {
        this.root.attr("transform", event.transform.toString());
      });
    this.svg.call(this.zoomBehavior).on("dblclick.zoom", null);

    // Seed an initial centered identity transform.
    this.svg.call(
      this.zoomBehavior.transform,
      zoomIdentity.translate(opts.width / 2, opts.height / 2),
    );
  }

  /** Render a new Graph. Replaces any prior state — this view has no memory. */
  render(graph: Graph): void {
    this.graph = graph;
    this.derived = deriveLoops(graph);
    this.activeLoopId = null;
    this.engine = createEngine(graph, { dt: ANIM_DT, integrator: ANIM_INTEGRATOR });
    this.equilib = equilibrium(graph, { dt: ANIM_DT, integrator: ANIM_INTEGRATOR });
    this.trackedNodeId = graph.nodes[0]?.id ?? null;
    this.histories = new Map();
    this.cumulative = new Map();
    this.monitorBuilt = false;
    this.buildSimNodes();
    this.buildSimEdges();
    this.startSimulation();
    this.draw();
    this.startLoop();
    this.buildMonitor();
  }

  /** Update only the loops (e.g. after an edit that changes edges). */
  refresh(): void {
    if (!this.graph) return;
    this.derived = deriveLoops(this.graph);
    this.drawLoopLabels();
    this.applyHighlight();
  }

  /** Highlight a single loop by id, or clear with null. */
  highlightLoop(loopId: string | null): void {
    this.activeLoopId = loopId;
    this.applyHighlight();
    const l = loopId ? this.derived.loops.find((x) => x.id === loopId) ?? null : null;
    this.opts.onLoopHover?.(l);
  }

  /**
   * Apply the Layer 2 heat overlay: color and size nodes by their constraint
   * score. Pass null to clear the overlay. This only restyles nodes — it does
   * NOT touch the force simulation, so sliders update live without re-running
   * layout (spec §3 acceptance: "without re-running layout").
   */
  applyHeat(scores: Map<string, number> | null): void {
    this.heat = scores;
    this.styleNodesForHeat();
  }

  /**
   * Draw Phase 5 migration arcs: dashed curved paths from the previous
   * constraint node to the new one, faded by recency (most recent = full
   * opacity, older = faded). Pass an empty array to clear.
   */
  drawMigrationArcs(arcs: MigrationArc[]): void {
    this.migrationArcs = arcs;
    this.renderMigrationArcs();
  }

  /** Tear down: stop the simulation and remove DOM listeners. */
  destroy(): void {
    this.stopLoop();
    this.sim?.stop();
    this.svg.on(".zoom", null);
    this.root.remove();
    if (this.monitorHost) this.monitorHost.innerHTML = "";
  }
  /** Start (or resume) the live animation: one engine step per frame. */
  play(): void {
    this.playing = true;
    this.startLoop();
  }

  /** Pause the live animation. */
  pause(): void {
    this.playing = false;
    this.stopLoop();
  }

  /** Reset the engine to the graph's initial state and clear the monitor. */
  resetLoopy(): void {
    if (!this.graph) return;
    this.engine?.reset();
    this.histories = new Map();
    this.cumulative = new Map();
    this.timeScale = 1;
    this.stepAcc = 0;
    this.slowStrength = 0;
    this.nudgeRing = null;
    this.nudgePulses = [];
    this.nudgePulseVisited = new Set();
    this.buildMonitor();
    this.drawSignals();
    this.drawNudgeFx(performance.now());
    this.styleNodeValues();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // --- live animation (a view over the engine) -------------------------

  private startLoop(): void {
    if (this.rafId !== null) return;
    if (!this.graph || !this.engine) return;
    const tick = (): void => {
      if (!this.playing || !this.graph || !this.engine) return;
      const now = performance.now();
      this.updateTimeScale(now);
      // Advance the engine by a fractional number of steps each frame, so a
      // sub-1 timeScale plays the simulation in slow motion (the post-nudge
      // transient becomes watchable instead of flashing past in one frame).
      this.stepAcc += this.timeScale;
      let n = Math.floor(this.stepAcc);
      this.stepAcc -= n;
      if (n > 4) {
        this.stepAcc += n - 4;
        n = 4;
      }
      for (let i = 0; i < n; i++) this.engine.step();
      this.drawSignals();
      this.drawNudgeFx(now);
      this.styleNodeValues();
      this.styleNodesForHeat();
      if (n > 0) this.stepMonitor();
      if (this.opts.onStep) {
        this.opts.onStep(
          degreesOfFreedom(this.graph, this.engine.state),
          this.graph.nodes.length,
        );
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Render the engine's delay pipelines as traveling pulses. Each FIFO bucket
   * of a delayed edge is a dot at fraction (i+0.5)/slots along the edge — a
   * pulse "p of the way through" the delay. Zero-delay edges carry no pulse.
   * The dot's colour follows the sign of the in-flight chunk (the signed rate
   * that entered the pipeline), so reinforcing (+) and balancing (−) pulses
   * read distinctly.
   */
  private drawSignals(): void {
    this.nudgeLayer.selectAll("*").remove();
  }

  /**
   * Seed the post-nudge slow motion and the transient nudge feedback (a ping
   * ring on the node plus a traveling dot on each outgoing edge). The slow
   * depth is proportional to the nudge's fraction of the node's operating
   * scale, so a standard 10% nudge slows fully and a relatively larger nudge
   * stays slower for longer. Pure view state — it never touches `Graph`.
   */
  private beginNudgeFx(nodeId: string, dir: number, delta: number): void {
    if (!this.graph) return;
    const now = performance.now();
    const scale = Math.max(Math.abs(this.equilib?.[nodeId] ?? 0), Math.abs(this.initialOf(nodeId)), 1);
    const frac = Math.min(1, Math.abs(delta) / scale / NUDGE_FRACTION);
    this.slowStrength = frac;
    this.slowStart = now;
    this.updateTimeScale(now);
    this.nudgeRing = { nodeId, dir, start: now };
    this.nudgePulseVisited = new Set();
    const outgoing = this.graph.edges.filter((e) => e.source === nodeId);
    for (const e of outgoing) {
      this.nudgePulseVisited.add(e.id);
    }
    this.nudgePulses = outgoing.map((e) => ({ edgeId: e.id, dir, start: now }));
  }

  /** Ease the post-nudge time-scale back up to 1 (full speed) along an
   * ease-out curve over `NUDGE_SLOW_MS`, proportionally to the slow depth. */
  private updateTimeScale(now: number): void {
    if (this.slowStrength <= 0) {
      this.timeScale = 1;
      return;
    }
    const elapsed = now - this.slowStart;
    if (elapsed >= NUDGE_SLOW_MS) {
      this.slowStrength = 0;
      this.timeScale = 1;
      return;
    }
    const u = elapsed / NUDGE_SLOW_MS;
    const minScale = 1 - this.slowStrength * (1 - NUDGE_SLOW_FLOOR);
    const eased = 1 - Math.pow(1 - u, 3);
    this.timeScale = minScale + (1 - minScale) * eased;
  }

  /**
   * Draw the nudge feedback onto the badge layer: an expanding, fading "ping"
   * ring on the nudged node, plus a single dot traveling along each outgoing
   * edge. Both are wall-clock driven so they move smoothly every frame —
   * independent of the slow-motion engine stepping.
   */
  private drawNudgeFx(now: number): void {
    if (!this.nudgeRing && this.nudgePulses.length === 0) return;
    const layer = this.nudgeLayer;
    if (this.nudgeRing) {
      const age = now - this.nudgeRing.start;
      if (age >= NUDGE_RING_MS) {
        this.nudgeRing = null;
      } else {
        const node = this.simNodes.find((nd) => nd.id === this.nudgeRing!.nodeId);
        if (node) {
          const u = age / NUDGE_RING_MS;
          const r = NODE_RADIUS + 6 + u * 24;
          // Hold full opacity for first third, then fade out.
          const opacity = u < 0.33 ? 0.8 : (1 - u) * 1.2 * 0.8;
          layer
            .append("circle")
            .attr("class", "nudge-ring")
            .attr("data-dir", this.nudgeRing.dir >= 0 ? "1" : "-1")
            .attr("cx", node.x)
            .attr("cy", node.y)
            .attr("r", r)
            .style("opacity", String(opacity));
        }
      }
    }
    if (this.nudgePulses.length > 0) {
      const edgeById = new Map(this.simEdges.map((e) => [e.id, e]));
      const newPulses: typeof this.nudgePulses = [];
      const completed: typeof this.nudgePulses = [];
      const active: typeof this.nudgePulses = [];
      for (const p of this.nudgePulses) {
        if (now - p.start >= NUDGE_PULSE_MS) {
          completed.push(p);
        } else {
          active.push(p);
        }
      }
      // Chain: for each completed pulse, spawn new pulses on outgoing edges of
      // the target node (skip already-visited edges to prevent cycles).
      if (this.graph && completed.length > 0) {
        for (const p of completed) {
          const simEdge = edgeById.get(p.edgeId);
          if (!simEdge) continue;
          const targetId = simEdge.target.id;
          const outgoing = this.graph.edges.filter(
            (e) => e.source === targetId && !this.nudgePulseVisited.has(e.id),
          );
          for (const e of outgoing) {
            this.nudgePulseVisited.add(e.id);
            // Start from exactly when the previous pulse arrived.
            newPulses.push({ edgeId: e.id, dir: p.dir, start: p.start + NUDGE_PULSE_MS });
          }
        }
      }
      this.nudgePulses = [...active, ...newPulses];
      // Draw all active pulses (including freshly spawned ones).
      for (const p of this.nudgePulses) {
        const e = edgeById.get(p.edgeId);
        if (!e) continue;
        const u = (now - p.start) / NUDGE_PULSE_MS;
        const frac = Math.min(1, u);
        const eased = 1 - Math.pow(1 - frac, 2);
        const x = e.source.x + (e.target.x - e.source.x) * eased;
        const y = e.source.y + (e.target.y - e.source.y) * eased;
        const opacity = frac > 0.75 ? (1 - frac) * 4 * 0.95 : 0.95;
        layer
          .append("circle")
          .attr("class", "signal nudge-pulse")
          .attr("data-sign", p.dir >= 0 ? "pos" : "neg")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", 7)
          .style("opacity", String(opacity));
      }
    }
  }

  /** Render migration arcs as dashed curved paths, faded by recency. */
  private renderMigrationArcs(): void {
    if (!this.graph) return;
    const byId = new Map(this.simNodes.map((n) => [n.id, n]));
    const arcs = this.migrationArcs.filter((a) => byId.has(a.from) && byId.has(a.to));
    const sel = this.migrationLayer
      .selectAll<SVGPathElement, MigrationArc>("path.migration-arc")
      .data(arcs, (d) => `${d.from}->${d.to}`);
    sel.exit().remove();
    const enter = sel
      .enter()
      .append("path")
      .attr("class", "migration-arc");
    enter.merge(sel).each((d, i, groups) => {
      const from = byId.get(d.from)!;
      const to = byId.get(d.to)!;
      if (from.id === to.id) return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) return;
      // Quadratic curve with perpendicular offset for a visible arc.
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const offset = Math.min(60, dist * 0.2);
      const nx = -dy / dist;
      const ny = dx / dist;
      const cx = mx + nx * offset;
      const cy = my + ny * offset;
      const el = groups[i];
      el.setAttribute("d", `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
      el.setAttribute("opacity", String(0.2 + 0.6 * d.recency));
    });
  }

  /**
   * Size and colour each node's inner value circle from the engine's physical
   * value, normalised for *display only*. Normalisation maps the value to the
   * [0,1] space the layout helpers expect (0.5 = the operating point), using
   * the node's own scale (its operating-point magnitude, or initial value, or
   * 1 as a floor). Colour is the sign of deviation from the operating point —
   * green above, red below — so growth vs. decline reads at a glance.
   */
  private styleNodeValues(): void {
    if (!this.engine) return;
    const eq = this.equilib ?? {};
    this.nodeLayer
      .selectAll<SVGGElement, SimNode>("g.node")
      .each((d, i, groups) => {
        const raw = this.engine?.state.values[d.id] ?? 0;
        const rest = eq[d.id] ?? 0;
        const scale = Math.max(Math.abs(rest), Math.abs(this.initialOf(d.id)), 1);
        const norm = 0.5 + 0.5 * clamp((raw - rest) / scale, -1, 1);
        const frac = valueRadiusFraction(norm);
        const { fill, opacity } = valueColor(norm);
        const circle = select(groups[i]).select(".node-value-circle");
        circle
          .attr("r", NODE_RADIUS * frac)
          .style("fill", fill)
          .style("opacity", String(opacity));
      });
  }

  // --- internals ---------------------------------------------------------

  /**
   * Record every node's current value into its rolling history and refresh
   * the monitor's sparklines. Called once per animation frame while playing.
   * A no-op if no host was provided.
   */
  private stepMonitor(): void {
    if (!this.engine || !this.monitorHost || !this.graph) return;
    const eq = this.equilib ?? {};
    for (const n of this.graph.nodes) {
      const v = this.engine.state.values[n.id] ?? 0;
      const rest = eq[n.id] ?? 0;
      const h = this.histories.get(n.id) ?? [];
      if (this.monitorMetric === "cumulative") {
        const cum = this.cumulative.get(n.id) ?? 0;
        const newCum = cum + (v - rest);
        this.cumulative.set(n.id, newCum);
        h.push(newCum);
      } else {
        h.push(v);
      }
      if (h.length > Layer1Renderer.HISTORY_CAP) h.shift();
      this.histories.set(n.id, h);
    }
    if (!this.monitorBuilt) this.buildMonitor();
    this.updateMonitorValues();
  }

  /**
   * Build the monitor's static structure into its host: a header, a node
   * dropdown (only when the graph has too many nodes to show all at once),
   * and a sparkline container. Called once on render/reset; the dropdown
   * change handler also calls this to rebuild for the new selection. This
   * is a view over the loopy animation state only — it holds no model state
   * and never writes to `Graph`.
   */
  private buildMonitor(): void {
    const host = this.monitorHost;
    if (!host || !this.graph) return;
    host.innerHTML = "";
    host.classList.add("node-monitor");

    const header = document.createElement("div");
    header.className = "node-monitor-head";
    const title = document.createElement("span");
    title.className = "node-monitor-title";
    title.textContent = "Live node monitor";
    header.append(title);

    // Value / Cumulative toggle.
    const toggleGroup = document.createElement("div");
    toggleGroup.className = "node-monitor-metric-toggle";
    (["value", "cumulative"] as const).forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = m === "value" ? "Value" : "Cumulative";
      btn.dataset.metric = m;
      btn.classList.toggle("is-selected", m === this.monitorMetric);
      btn.addEventListener("click", () => {
        if (this.monitorMetric === m) return;
        this.monitorMetric = m;
        this.histories = new Map();
        this.cumulative = new Map();
        toggleGroup
          .querySelectorAll("button")
          .forEach((b) => b.classList.toggle("is-selected", b.dataset.metric === m));
        this.updateMonitorValues();
      });
      toggleGroup.append(btn);
    });
    header.append(toggleGroup);
    host.append(header);

    this.monitorMode =
      this.graph.nodes.length < Layer1Renderer.ALL_NODES_THRESHOLD ? "all" : "single";

    if (this.monitorMode === "single") {
      const selectRow = document.createElement("label");
      selectRow.className = "node-monitor-select-row";
      const select = document.createElement("select");
      select.className = "node-monitor-select";
      select.dataset.role = "monitor-node-select";
      for (const n of this.graph.nodes) {
        const opt = document.createElement("option");
        opt.value = n.id;
        opt.textContent = n.label;
        if (n.id === this.trackedNodeId) opt.selected = true;
        select.append(opt);
      }
      select.addEventListener("change", () => {
        this.trackedNodeId = select.value;
        this.updateMonitorValues();
      });
      selectRow.append(select);
      host.append(selectRow);
    }

    const container = document.createElement("div");
    container.className = "node-monitor-sparklines";
    container.dataset.role = "monitor-sparklines";
    host.append(container);

    this.monitorBuilt = true;
    this.updateMonitorValues();
  }

  /**
   * Refresh the monitor's sparkline paths and value readouts without
   * rebuilding the dropdown (so the user's open dropdown is not disturbed).
   * Called every animation frame.
   */
  private updateMonitorValues(): void {
    if (!this.monitorBuilt || !this.engine || !this.graph || !this.monitorHost) return;
    const eq = this.equilib ?? {};
    const container = this.monitorHost.querySelector<HTMLElement>(
      '[data-role="monitor-sparklines"]',
    );
    if (!container) return;
    container.innerHTML = "";

    // Sync the dropdown selection to the tracked node (e.g. after a nudge).
    const select = this.monitorHost.querySelector<HTMLSelectElement>(
      '[data-role="monitor-node-select"]',
    );
    if (select && this.trackedNodeId && select.value !== this.trackedNodeId) {
      select.value = this.trackedNodeId;
    }

    const nodeIds =
      this.monitorMode === "all"
        ? this.graph.nodes.map((n) => n.id)
        : this.trackedNodeId
          ? [this.trackedNodeId]
          : [];

    for (const id of nodeIds) {
      const node = this.graph.nodes.find((n) => n.id === id);
      if (!node) continue;
      const hist = this.histories.get(id) ?? [];
      const current = this.engine.state.values[id] ?? 0;
      const rest = eq[id] ?? 0;
      const scale = Math.max(Math.abs(rest), Math.abs(this.initialOf(id)), 1);
      const norm = 0.5 + 0.5 * clamp((current - rest) / scale, -1, 1);
      const { fill } = valueColor(norm);
      const slColor = this.monitorMetric === "cumulative" ? "#1976d2" : fill;
      const displayVal =
        this.monitorMetric === "cumulative"
          ? (this.cumulative.get(id) ?? 0).toFixed(2)
          : current.toFixed(2);

      const card = document.createElement("div");
      card.className = "node-monitor-card";
      const label = document.createElement("div");
      label.className = "node-monitor-card-label";
      label.textContent = `${node.label} \u00b7 ${displayVal}`;
      label.style.color = slColor;
      card.append(label);

      if (hist.length >= 2) {
        const series: SparklineSeries[] = [
          {
            label: "value",
            color: slColor,
            points: hist.map((y, i) => ({ x: i, y })),
          },
        ];
        const slHeight = this.monitorMode === "all" ? 56 : 90;
        const sl = sparkline(series, { width: 270, height: slHeight });
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", sl.viewBox);
        svg.setAttribute("class", "node-monitor-svg");
        svg.setAttribute("preserveAspectRatio", "none");
        for (const p of sl.paths) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", p.d);
          path.setAttribute("stroke", p.color);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke-width", "1.5");
          path.setAttribute("stroke-linejoin", "round");
          path.setAttribute("stroke-linecap", "round");
          svg.append(path);
        }
        card.append(svg);
      }
      container.append(card);
    }
  }

  private buildSimNodes(): void {
    if (!this.graph) return;
    const cx = this.opts.width / 2;
    const cy = this.opts.height / 2;
    this.simNodes = this.graph.nodes.map((n, i) => {
      const angle = (i / Math.max(1, this.graph!.nodes.length)) * 2 * Math.PI;
      const baseX = n.pin ? n.pin.x : cx + 120 * Math.cos(angle);
      const baseY = n.pin ? n.pin.y : cy + 120 * Math.sin(angle);
      return {
        id: n.id,
        label: n.label,
        x: baseX,
        y: baseY,
        fx: n.pin ? n.pin.x : null,
        fy: n.pin ? n.pin.y : null,
        pinned: Boolean(n.pin),
      };
    });
  }

  private buildSimEdges(): void {
    if (!this.graph) return;
    const byId = new Map(this.simNodes.map((n) => [n.id, n]));
    this.simEdges = this.graph.edges
      .map((e: Edge): SimEdge | null => {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) return null;
        return {
          id: e.id,
          source: s,
          target: t,
          polarity: e.polarity,
          delayType: e.delay.type,
          delayMagnitude: e.delay.magnitude,
          strength: e.strength,
        };
      })
      .filter((e): e is SimEdge => e !== null);
  }

  private startSimulation(): void {
    this.sim?.stop();
    this.sim = forceSimulation<SimNode>(this.simNodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(this.simEdges)
          .id((d) => d.id)
          .distance(120)
          .strength(0.4),
      )
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(0, 0))
      .alpha(1)
      .alphaDecay(0.04)
      .on("tick", () => this.tick())
      .on("end", () => this.fitZoom());
  }

  /** Zoom to fit all nodes in the viewport with padding, called once after the
   * force simulation cools. Gives the graph a comfortable reading scale so
   * polarity chips and delay numbers are legible without manual zooming. */
  private fitZoom(): void {
    if (this.simNodes.length === 0) return;
    const pad = 80;
    // Reserve space for the right-side monitor panel (340px wide + 24px margin).
    const availW = this.opts.width - 380;
    const availH = this.opts.height;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this.simNodes) {
      minX = Math.min(minX, n.x - NODE_RADIUS);
      maxX = Math.max(maxX, n.x + NODE_RADIUS);
      minY = Math.min(minY, n.y - NODE_RADIUS);
      maxY = Math.max(maxY, n.y + NODE_RADIUS);
    }
    const graphW = maxX - minX + pad * 2;
    const graphH = maxY - minY + pad * 2;
    const scale = Math.min(
      availW / graphW,
      availH / graphH,
      2,  // don't zoom in past 2× even on tiny graphs
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Center in the available area (left of the monitor panel).
    const offsetX = availW / 2;
    this.svg.call(
      this.zoomBehavior.transform,
      zoomIdentity
        .translate(offsetX, this.opts.height / 2)
        .scale(scale)
        .translate(-cx, -cy),
    );
  }

  private tick(): void {
    this.drawEdges();
    this.drawNodes();
    this.drawLoopLabels();
    this.renderMigrationArcs();
  }

  private draw(): void {
    this.drawEdges();
    this.drawNodes();
    this.drawLoopLabels();
    this.bindInteraction();
  }

  private drawEdges(): void {
    // Edge lines and arrows in linkLayer (below signal dots).
    const sel = this.linkLayer
      .selectAll<SVGGElement, SimEdge>("g.edge")
      .data(this.simEdges, (d) => d.id);

    sel.exit().remove();

    const enter = sel
      .enter()
      .append("g")
      .attr("class", "edge")
      .attr("data-edge-id", (d) => d.id);

    enter.append("path").attr("class", "edge-line");
    enter.append("path").attr("class", "edge-arrow");
    enter.append("g").attr("class", "edge-hash");

    const merged = enter.merge(sel);

    // Badge elements (polarity circle + text, delay number) in badgeLayer so
    // they render above the signal-dot layer and are never obscured.
    const bsel = this.badgeLayer
      .selectAll<SVGGElement, SimEdge>("g.edge-badge")
      .data(this.simEdges, (d) => d.id);

    bsel.exit().remove();

    const benter = bsel
      .enter()
      .append("g")
      .attr("class", "edge-badge")
      .attr("data-edge-id", (d) => d.id);

    benter.append("circle").attr("class", "edge-polarity-bg");
    benter.append("text").attr("class", "edge-polarity");
    benter.append("text").attr("class", "edge-delay-badge");

    const bmerged = benter.merge(bsel);

    merged.each((d, i, groups) => this.layoutEdge(groups[i], d));
    bmerged.each((d, i, groups) => this.layoutEdgeBadge(groups[i], d));
  }

  private layoutEdge(el: SVGGElement, d: SimEdge): void {
    const { source, target } = shortenToCircleBounds(
      { x: d.source.x, y: d.source.y },
      { x: d.target.x, y: d.target.y },
      NODE_RADIUS,
      NODE_RADIUS,
    );
    const geom = edgeGeometry(source, target);
    const g = select(el);
    g.select(".edge-line")
      .attr("d", geom.path)
      .style("stroke-width", String(Math.max(1.5, 3 * Math.abs(d.strength) - 1)));

    const [tip, leftWing, rightWing] = arrowHead(geom, target, ARROW_SIZE);
    g.select(".edge-arrow").attr(
      "d",
      `M${leftWing.x},${leftWing.y} L${tip.x},${tip.y} L${rightWing.x},${rightWing.y}`,
    );

    const hash = g.select(".edge-hash");
    hash.selectAll("line").remove();
    if (hasDelay({ delay: { type: d.delayType as Edge["delay"]["type"], magnitude: d.delayMagnitude } } as Edge)) {
      const [a1, a2, b1, b2] = delayHashMarksDouble(geom);
      hash.append("line").attr("x1", a1.x).attr("y1", a1.y).attr("x2", a2.x).attr("y2", a2.y);
      hash.append("line").attr("x1", b1.x).attr("y1", b1.y).attr("x2", b2.x).attr("y2", b2.y);
    }
  }

  private layoutEdgeBadge(el: SVGGElement, d: SimEdge): void {
    const { source, target } = shortenToCircleBounds(
      { x: d.source.x, y: d.source.y },
      { x: d.target.x, y: d.target.y },
      NODE_RADIUS,
      NODE_RADIUS,
    );
    const geom = edgeGeometry(source, target);
    const g = select(el);

    g.select(".edge-polarity-bg")
      .attr("cx", geom.midpoint.x)
      .attr("cy", geom.midpoint.y)
      .attr("r", POLARITY_BADGE_R)
      .attr("data-polarity", d.polarity);
    g.select(".edge-polarity")
      .attr("x", geom.midpoint.x)
      .attr("y", geom.midpoint.y)
      .attr("data-polarity", d.polarity)
      .text(polaritySymbol({ polarity: d.polarity } as Edge));

    const badge = g.select(".edge-delay-badge");
    if (hasDelay({ delay: { type: d.delayType as Edge["delay"]["type"], magnitude: d.delayMagnitude } } as Edge)) {
      const bp = delayBadgePosition(geom);
      badge
        .attr("x", bp.x)
        .attr("y", bp.y)
        .text(delayBadge({ delay: { type: d.delayType as Edge["delay"]["type"], magnitude: d.delayMagnitude } } as Edge));
    } else {
      badge.text("");
    }
  }

  private drawNodes(): void {
    const sel = this.nodeLayer
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(this.simNodes, (d) => d.id);

    sel.exit().remove();

    const enter = sel
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("data-node-id", (d) => d.id);

    enter.append("circle").attr("class", "node-circle").attr("r", NODE_RADIUS);
    enter.append("circle").attr("class", "node-value-circle").attr("r", NODE_RADIUS * 0.5);
    enter.append("text").attr("class", "node-label");

    // Loopy-style up/down nudge arrows, revealed on hover. Clicking one
    // nudges the node's value (and emits a signed signal onto its outgoing
    // edges) so the direction of growth is up or down from this node.
    const upY = -(NODE_RADIUS + NUDGE_ARROW_OFFSET);
    const downY = NODE_RADIUS + NUDGE_ARROW_OFFSET;
    enter
      .append("circle")
      .attr("class", "node-nudge-arrow node-nudge-arrow-up")
      .attr("r", 9)
      .attr("cy", upY)
      .attr("data-dir", "1");
    enter
      .append("text")
      .attr("class", "node-nudge-arrow-text node-nudge-arrow-up-text")
      .attr("x", 0)
      .attr("y", upY)
      .attr("data-dir", "1")
      .text("\u25B2");
    enter
      .append("circle")
      .attr("class", "node-nudge-arrow node-nudge-arrow-down")
      .attr("r", 9)
      .attr("cy", downY)
      .attr("data-dir", "-1");
    enter
      .append("text")
      .attr("class", "node-nudge-arrow-text node-nudge-arrow-down-text")
      .attr("x", 0)
      .attr("y", downY)
      .attr("data-dir", "-1")
      .text("\u25BC");

    const merged = enter.merge(sel);
    merged.attr("transform", (d) => `translate(${d.x},${d.y})`);
    merged
      .select(".node-label")
      .attr("y", NODE_RADIUS + 14)
      .attr("text-anchor", "middle")
      .text((d) => d.label);
    merged.classed("is-pinned", (d) => d.pinned);
    this.styleNodesForHeat();
    this.styleNodeValues();
  }

  /** Apply (or clear) the Layer 2 heat overlay + pinned-collar rings. */
  private styleNodesForHeat(): void {
    const sel = this.nodeLayer.selectAll<SVGGElement, SimNode>("g.node");
    sel.each((d, i, groups) => {
      const score = this.heat?.get(d.id) ?? 0;
      const hasHeat = this.heat !== null && this.heat.has(d.id);
      const circle = select(groups[i]).select(".node-circle");
      if (hasHeat) {
        circle
          .attr("fill", heatColor(score))
          .attr("r", heatRadius(NODE_RADIUS, score));
      } else {
        // Restore Layer 1 defaults (CSS-driven fill + base radius).
        circle.attr("fill", null).attr("r", NODE_RADIUS);
      }
      // Collar-pinned ring: solid for upper, dashed for lower (§2.6).
      const pin = this.engine?.state.pinned[d.id] ?? null;
      circle
        .classed("is-pinned-upper", pin === "upper")
        .classed("is-pinned-lower", pin === "lower");
    });
  }

  private drawLoopLabels(): void {
    if (!this.graph) return;
    const positions = new Map<string, Point>(
      this.simNodes.map((n) => [n.id, { x: n.x, y: n.y }]),
    );
    const sel = this.labelLayer
      .selectAll<SVGGElement, Loop>("g.loop-label")
      .data(this.derived.loops, (d) => d.id);

    sel.exit().remove();

    const enter = sel
      .enter()
      .append("g")
      .attr("class", "loop-label")
      .attr("data-loop-id", (d) => d.id);
    enter.append("text").attr("class", "loop-label-text");

    const merged = enter.merge(sel);
    merged.each((d, i, groups) => {
      const c = loopCentroid(d, positions);
      select(groups[i])
        .attr("transform", `translate(${c.x},${c.y})`)
        .select(".loop-label-text")
        .text(loopLabel(d))
        .attr("text-anchor", "middle")
        .attr("class", `loop-label-text loop-${d.sign}`);
    });
  }

  private bindInteraction(): void {
    const dragBehavior = drag<SVGGElement, SimNode>()
      .on("start", (event) => {
        if (!event.active) this.sim?.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on("drag", (event) => {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
        event.subject.x = event.x;
        event.subject.y = event.y;
      })
      .on("end", (event) => {
        if (!event.active) this.sim?.alphaTarget(0);
        const pin = { x: event.subject.x, y: event.subject.y };
        event.subject.pinned = true;
        // Persist the pin back to the model via the callback (single source of truth).
        this.opts.onPin?.(event.subject.id, pin);
      });

    this.nodeLayer
      .selectAll<SVGGElement, SimNode>("g.node")
      .call(dragBehavior)
      .on("mouseenter", (_, d) => {
        // Hovering a node highlights every loop it belongs to, in turn dimming
        // unrelated edges — the spec's "loop highlight on hover".
        const loops = this.derived.loops.filter((l) => l.nodes.includes(d.id));
        const loopId = loops.length > 0 ? loops[0].id : null;
        this.highlightLoop(loopId);
      })
      .on("mouseleave", () => this.highlightLoop(null))
      // Shift-click opens the edit modal (spec §2: edit mode). A plain click
      // stays a no-op here (nudges go through the up/down arrows below); the
      // edit modal is the channel for writing node properties back to the YAML.
      .on("click", (event, d) => {
        if (!event.shiftKey) return;
        if (!this.graph) return;
        const node = this.graph.nodes.find((n) => n.id === d.id);
        if (!node) return;
        event.stopPropagation();
        openEditModal(
          node,
          this.graph,
          (patch) => this.opts.onEditNode?.(d.id, patch),
        );
      });

    // The up/down arrows revealed on hover nudge the node's value up/down.
    // A nudge calls `engine.impulse` — the same operation Layer 3 uses for an
    // intervention Δ — so a canvas nudge and an equivalent L3 Δ drive the same
    // engine and produce the same trajectory (Phase 1 acceptance).
    const nudgeNode = (nodeId: string, dir: number, event: MouseEvent): void => {
      if (!this.graph || !this.engine) return;
      const delta = dir * this.nudgeDeltaFor(nodeId);
      this.engine.impulse(nodeId, delta);
      // Track this node for the live monitor (in single-node mode the dropdown
      // follows the nudge; in all-nodes mode every sparkline is already shown).
      this.trackedNodeId = nodeId;
      this.beginNudgeFx(nodeId, dir, delta);
      this.styleNodeValues();
      this.drawSignals();
      this.drawNudgeFx(performance.now());
      this.stepMonitor();
      this.opts.onNudge?.(nodeId, dir);
      event.stopPropagation();
    };
    // Stop the node's drag from starting when the user presses on an arrow;
    // d3-drag listens for pointerdown on the parent <g>, which would otherwise
    // swallow the arrow press.
    const swallowDrag = (event: Event): void => event.stopPropagation();
    this.nodeLayer
      .selectAll<SVGGElement, SimNode>(".node-nudge-arrow-up, .node-nudge-arrow-up-text")
      .on("pointerdown", swallowDrag)
      .on("mousedown", swallowDrag)
      .on("click", function (event, d) {
        nudgeNode(d.id, 1, event as MouseEvent);
      });
    this.nodeLayer
      .selectAll<SVGGElement, SimNode>(".node-nudge-arrow-down, .node-nudge-arrow-down-text")
      .on("pointerdown", swallowDrag)
      .on("mousedown", swallowDrag)
      .on("click", function (event, d) {
        nudgeNode(d.id, -1, event as MouseEvent);
      });

    this.labelLayer
      .selectAll<SVGGElement, Loop>("g.loop-label")
      .on("mouseenter", (_, d) => this.highlightLoop(d.id))
      .on("mouseleave", () => this.highlightLoop(null));
  }

  /** A node's authored `initial_value`, or 0 if not found. */
  private initialOf(nodeId: string): number {
    return this.graph?.nodes.find((n) => n.id === nodeId)?.initial_value ?? 0;
  }

  /** Per-node nudge magnitude: 10% of the node's operating-point scale, so a
   * nudge is visible relative to the node's own magnitude regardless of units. */
  private nudgeDeltaFor(nodeId: string): number {
    const rest = this.equilib?.[nodeId] ?? 0;
    const scale = Math.max(Math.abs(rest), Math.abs(this.initialOf(nodeId)), 1);
    return NUDGE_FRACTION * scale;
  }

  private applyHighlight(): void {
    const loop = this.activeLoopId
      ? this.derived.loops.find((l) => l.id === this.activeLoopId)
      : null;
    const edgeIds = new Set(loop?.edges ?? []);
    const nodeIds = new Set(loop?.nodes ?? []);

    this.linkLayer
      .selectAll<SVGGElement, SimEdge>("g.edge")
      .classed(HIGHLIGHTED_CLASS, (d) => edgeIds.has(d.id))
      .classed(DIMMED_CLASS, (d) => loop !== null && !edgeIds.has(d.id));

    this.nodeLayer
      .selectAll<SVGGElement, SimNode>("g.node")
      .classed(HIGHLIGHTED_CLASS, (d) => nodeIds.has(d.id))
      .classed(DIMMED_CLASS, (d) => loop !== null && !nodeIds.has(d.id));

    this.labelLayer
      .selectAll<SVGGElement, Loop>("g.loop-label")
      .classed(HIGHLIGHTED_CLASS, (d) => d.id === this.activeLoopId)
      .classed(DIMMED_CLASS, (d) => this.activeLoopId !== null && d.id !== this.activeLoopId);
  }
}

/** Clamp `v` to the closed range [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

