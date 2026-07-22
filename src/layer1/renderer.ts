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
  delayBadge,
  delayHashMarksDouble,
  edgeGeometry,
  hasDelay,
  heatColor,
  heatRadius,
  loopCentroid,
  loopLabel,
  polaritySymbol,
  shortenToCircleBounds,
  type Point,
} from "./layout";

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
const HIGHLIGHTED_CLASS = "is-highlighted";
const DIMMED_CLASS = "is-dimmed";

export interface RendererOptions {
  width: number;
  height: number;
  /** Highlight a loop when the user hovers/selects it. */
  onLoopHover?: (loop: Loop | null) => void;
  /** Persist a manual pin onto the Graph's node. */
  onPin?: (nodeId: string, pin: Point | null) => void;
}

export class Layer1Renderer {
  private readonly svg: Selection<SVGSVGElement, unknown, null, unknown>;
  private readonly root: Selection<SVGGElement, unknown, null, unknown>;
  private readonly linkLayer: Selection<SVGGElement, unknown, null, unknown>;
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

  constructor(svg: SVGSVGElement, opts: RendererOptions) {
    this.opts = opts;
    this.svg = select(svg);
    this.svg.attr("viewBox", `0 0 ${opts.width} ${opts.height}`);

    // A single zoomable group holds all layers so pan/zoom is unified.
    this.root = this.svg.append("g").attr("class", "layer1-root");
    this.linkLayer = this.root.append("g").attr("class", "layer1-links");
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
    this.buildSimNodes();
    this.buildSimEdges();
    this.startSimulation();
    this.draw();
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
    this.sim?.stop();
    this.svg.on(".zoom", null);
    this.root.remove();
  }

  // --- internals ---------------------------------------------------------

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
    g.select(".edge-line").attr("d", geom.path);
    // Arrowhead: a small triangle at the target end, oriented along the edge.
    const ax = source.x + geom.direction.x * (geom.length - 6);
    const ay = source.y + geom.direction.y * (geom.length - 6);
    const perp = { x: -geom.direction.y, y: geom.direction.x };
    const arrow = `M${ax + perp.x * 4},${ay + perp.y * 4} L${ax + geom.direction.x * 8},${
      ay + geom.direction.y * 8
    } L${ax - perp.x * 4},${ay - perp.y * 4} Z`;
    g.select(".edge-arrow").attr("d", arrow);

    g.select(".edge-polarity")
      .attr("x", geom.midpoint.x - 4)
      .attr("y", geom.midpoint.y - 6)
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
      badge
        .attr("x", geom.midpoint.x + 8)
        .attr("y", geom.midpoint.y + 12)
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
    enter.append("text").attr("class", "node-label");

    const merged = enter.merge(sel);
    merged.attr("transform", (d) => `translate(${d.x},${d.y})`);
    merged
      .select(".node-label")
      .attr("y", NODE_RADIUS + 14)
      .attr("text-anchor", "middle")
      .text((d) => d.label);
    merged.classed("is-pinned", (d) => d.pinned);
    this.styleNodesForHeat();
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
