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
import {
  NUDGE_DELTA,
  initialLoopyState,
  nudge as nudgeState,
  step as stepLoopy,
  type LoopyState,
  type Signal,
} from "./signal";
import { sparkline, type SparklineSeries } from "@/layer3";

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
const SIGNAL_SPEED = 0.035; // fraction of edge per animation frame (loopy-like)
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
   * A node's loopy-style up/down nudge arrow was clicked (loopy-style play).
   * The up arrow nudges the node's value up by `NUDGE_DELTA` (growth in the
   * positive direction); the down arrow nudges it down by `NUDGE_DELTA`
   * (growth in the negative direction). Either emits a signed signal onto the
   * node's outgoing edges carrying that delta, so the direction of growth
   * propagates to the next node and onward around the loop. `direction` is
   * +1 for up, -1 for down; used to drive the Layer 3 intervention sign so
   * the sparklines re-simulate from the canvas nudge. The loopy animation
   * itself is view-only and never writes to `Graph` (per src/layer1/signal.ts);
   * this callback is the only outward channel.
   */
  onNudge?: (nodeId: string, direction: number) => void;
}

export class Layer1Renderer {
  private readonly svg: Selection<SVGSVGElement, unknown, null, unknown>;
  private readonly root: Selection<SVGGElement, unknown, null, unknown>;
  private readonly linkLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly signalLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly nodeLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly labelLayer: Selection<SVGGElement, unknown, null, unknown>;
  private readonly zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

  private graph: Graph | null = null;
  private derived: DerivedLoops = { loops: [], idByKey: new Map() };
  private sim: Simulation<SimNode, undefined> | null = null;
  private simNodes: SimNode[] = [];
  private simEdges: SimEdge[] = [];
  private activeLoopId: string | null = null;
  /** Layer 2 heat overlay: node id -> score in [0,1]. null = no overlay. */
  private heat: Map<string, number> | null = null;
  private readonly opts: RendererOptions;

  /** Loopy-style signal simulation state (view-layer animation only). */
  private loopy: LoopyState | null = null;
  private playing = true;
  private rafId: number | null = null;

  /** Live node monitor: rolling history of the last-nudged node's value. */
  private monitorHost: HTMLElement | null = null;
  private trackedNodeId: string | null = null;
  private history: number[] = [];
  private monitorT = 0;
  private static readonly HISTORY_CAP = 200;

  constructor(svg: SVGSVGElement, opts: RendererOptions) {
    this.opts = opts;
    this.monitorHost = opts.monitorHost ?? null;
    this.svg = select(svg);
    this.svg.attr("viewBox", `0 0 ${opts.width} ${opts.height}`);

    // A single zoomable group holds all layers so pan/zoom is unified.
    this.root = this.svg.append("g").attr("class", "layer1-root");
    this.linkLayer = this.root.append("g").attr("class", "layer1-links");
    this.signalLayer = this.root.append("g").attr("class", "layer1-signals");
    this.labelLayer = this.root.append("g").attr("class", "layer1-loop-labels");
    this.nodeLayer = this.root.append("g").attr("class", "layer1-nodes");

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
    this.loopy = initialLoopyState(graph);
    this.trackedNodeId = null;
    this.history = [];
    this.monitorT = 0;
    this.buildSimNodes();
    this.buildSimEdges();
    this.startSimulation();
    this.draw();
    this.startLoopyLoop();
    this.renderMonitor();
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

  /** Tear down: stop the simulation and remove DOM listeners. */
  destroy(): void {
    this.stopLoopyLoop();
    this.sim?.stop();
    this.svg.on(".zoom", null);
    this.root.remove();
    if (this.monitorHost) this.monitorHost.innerHTML = "";
  }

  /** Start (or resume) the loopy-style signal animation. */
  play(): void {
    this.playing = true;
    this.startLoopyLoop();
  }

  /** Pause the signal animation. */
  pause(): void {
    this.playing = false;
    this.stopLoopyLoop();
  }

  /** Reset all node values to rest and clear traveling signals. */
  resetLoopy(): void {
    if (!this.graph) return;
    this.loopy = initialLoopyState(this.graph);
    this.history = [];
    this.monitorT = 0;
    this.drawSignals();
    this.styleNodeValues();
    this.renderMonitor();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // --- loopy signal animation ------------------------------------------

  private startLoopyLoop(): void {
    if (this.rafId !== null) return;
    if (!this.graph || !this.loopy) return;
    const tick = (): void => {
      if (!this.playing || !this.graph || !this.loopy) return;
      this.loopy = stepLoopy(this.loopy, this.graph, SIGNAL_SPEED);
      this.drawSignals();
      this.styleNodeValues();
      this.stepMonitor();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoopyLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Render the traveling pulses as small dots along each edge. */
  private drawSignals(): void {
    if (!this.loopy) return;
    const edgeById = new Map(this.simEdges.map((e) => [e.id, e]));
    this.signalLayer.selectAll("*").remove();
    if (this.loopy.signals.length === 0) return;
    const dots = this.signalLayer
      .selectAll<SVGCircleElement, Signal>("circle.signal")
      .data(this.loopy.signals)
      .enter()
      .append("circle")
      .attr("class", "signal")
      .attr("r", 5);
    dots.each((d, i, groups) => {
      const e = edgeById.get(d.edgeId);
      const el = groups[i];
      if (!e) {
        el.setAttribute("visibility", "hidden");
        return;
      }
      el.setAttribute("visibility", "visible");
      const sx = e.source.x + (e.target.x - e.source.x) * d.position;
      const sy = e.source.y + (e.target.y - e.source.y) * d.position;
      el.setAttribute("cx", String(sx));
      el.setAttribute("cy", String(sy));
      el.setAttribute("data-sign", d.delta >= 0 ? "pos" : "neg");
    });
  }

  /** Size and color each node's inner value circle from its loopy value (loopy-style). */
  private styleNodeValues(): void {
    if (!this.loopy) return;
    this.nodeLayer
      .selectAll<SVGGElement, SimNode>("g.node")
      .each((d, i, groups) => {
        const v = this.loopy?.values.get(d.id) ?? 0.5;
        const frac = valueRadiusFraction(v);
        const { fill, opacity } = valueColor(v);
        const circle = select(groups[i]).select(".node-value-circle");
        circle
          .attr("r", NODE_RADIUS * frac)
          .style("fill", fill)
          .style("opacity", String(opacity));
      });
  }

  // --- internals ---------------------------------------------------------

  /**
   * Record the tracked node's current value and redraw the live monitor
   * sparkline. Called once per animation frame while playing; a no-op if no
   * host was provided or no node has been nudged yet.
   */
  private stepMonitor(): void {
    if (!this.loopy || !this.monitorHost) return;
    if (this.trackedNodeId === null) {
      this.renderMonitor();
      return;
    }
    const v = this.loopy.values.get(this.trackedNodeId) ?? 0.5;
    this.history.push(v);
    if (this.history.length > Layer1Renderer.HISTORY_CAP) this.history.shift();
    this.monitorT += 1;
    this.renderMonitor();
  }

  /**
   * Render the live node monitor into its HTML host: the tracked node's label
   * and current value, plus a sparkline of its value over the recent animation
   * frames. This is a view over the loopy animation state only — it holds no
   * model state and never writes to `Graph`.
   */
  private renderMonitor(): void {
    const host = this.monitorHost;
    if (!host) return;
    host.innerHTML = "";
    host.classList.add("node-monitor");
    const header = document.createElement("div");
    header.className = "node-monitor-head";
    const title = document.createElement("span");
    title.className = "node-monitor-title";
    title.textContent = "Live node monitor";
    const sub = document.createElement("span");
    sub.className = "node-monitor-sub";
    if (this.trackedNodeId === null) {
      sub.textContent = "nudge a node to plot its value over time";
      header.append(title, sub);
      host.append(header);
      return;
    }
    const label = this.graph?.nodes.find((n) => n.id === this.trackedNodeId)?.label ?? this.trackedNodeId;
    const current = this.history.length > 0 ? this.history[this.history.length - 1] : 0.5;
    sub.textContent = `${label} \u00b7 ${current.toFixed(2)}`;
    header.append(title, sub);
    host.append(header);

    if (this.history.length < 2) return;
    const series: SparklineSeries[] = [
      {
        label: "value",
        color: "#1976d2",
        points: this.history.map((y, i) => ({ x: i, y })),
      },
    ];
    const sl = sparkline(series, { width: 240, height: 52 });
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
    host.append(svg);
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
      .on("tick", () => this.tick());
  }

  private tick(): void {
    this.drawEdges();
    this.drawNodes();
    this.drawLoopLabels();
  }

  private draw(): void {
    this.drawEdges();
    this.drawNodes();
    this.drawLoopLabels();
    this.bindInteraction();
  }

  private drawEdges(): void {
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
    enter.append("circle").attr("class", "edge-polarity-bg");
    enter.append("text").attr("class", "edge-polarity");
    enter.append("g").attr("class", "edge-hash");
    enter.append("text").attr("class", "edge-delay-badge");

    const merged = enter.merge(sel);
    merged.each((d, i, groups) => this.layoutEdge(groups[i], d));
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
    // Edge line weight scales with strength so influence reads at a glance
    // (loopy: lineWidth = 4*|strength|-2). Floor at 1.5 for visibility.
    g.select(".edge-line")
      .attr("d", geom.path)
      .style("stroke-width", String(Math.max(1.5, 3 * Math.abs(d.strength) - 1)));

    // Prominent chevron arrowhead at the target (loopy-style).
    const [tip, leftWing, rightWing] = arrowHead(geom, target, ARROW_SIZE);
    g.select(".edge-arrow").attr(
      "d",
      `M${leftWing.x},${leftWing.y} L${tip.x},${tip.y} L${rightWing.x},${rightWing.y}`,
    );

    // Polarity badge: a small rounded chip at the midpoint carrying the +/−
    // symbol — clearer against the edge than a bare glyph (loopy draws a
    // label at the midpoint). Data attributes let CSS style it.
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

    const hash = g.select(".edge-hash");
    hash.selectAll("line").remove();
    const badge = g.select(".edge-delay-badge");
    if (hasDelay({ delay: { type: d.delayType as Edge["delay"]["type"], magnitude: d.delayMagnitude } } as Edge)) {
      const [a1, a2, b1, b2] = delayHashMarksDouble(geom);
      hash
        .append("line")
        .attr("x1", a1.x)
        .attr("y1", a1.y)
        .attr("x2", a2.x)
        .attr("y2", a2.y);
      hash
        .append("line")
        .attr("x1", b1.x)
        .attr("y1", b1.y)
        .attr("x2", b2.x)
        .attr("y2", b2.y);
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

  /** Apply (or clear) the Layer 2 heat overlay styling on node circles. */
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
      .on("mouseleave", () => this.highlightLoop(null));

    // Loopy-style play: the up/down arrows revealed on hover nudge the node's
    // value up/down by NUDGE_DELTA. A nudge emits a signed signal onto every
    // outgoing edge — the delta's sign sets the direction of growth from this
    // node to the next, and that sign keeps circulating around the loop.
    const nudgeNode = (nodeId: string, dir: number, event: MouseEvent): void => {
      if (!this.graph || !this.loopy) return;
      this.loopy = nudgeState(this.loopy, this.graph, nodeId, dir * NUDGE_DELTA);
      // Track this node for the live monitor and start a fresh history so the
      // sparkline shows this nudge's effect from a clean baseline.
      this.trackedNodeId = nodeId;
      this.history = [];
      this.monitorT = 0;
      this.styleNodeValues();
      this.drawSignals();
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

