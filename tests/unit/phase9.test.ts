import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import { withComputedLoops } from "@/graph/loops";
import { DEFAULT_ENGINE_OPTIONS } from "@/sim";
import { DEFAULT_WEIGHTS } from "@/layer2/scoring";
import type { TypedIntervention } from "@/layer3/intervention";
import {
  pinScenario,
  addCard,
  removeCard,
  chooseCard,
  nextScenarioId,
  scenarioLabel,
  emptyTray,
  type ScenarioTray,
} from "@/scenario/scenario";
import { graphToMermaid } from "@/scenario/mermaid";
import { exportDecisionRecord } from "@/scenario/export";
import { loadSession, saveSession } from "@/io/session";

// --- fixture builders (mirror the migration-test fixtures) -----------------

function stock(id: string, value = 0, collar?: Node["collar"], cap?: number): Node {
  const n: Node = { id, label: id, type: "stock", initial_value: value, unit: "u" };
  if (collar) n.collar = collar;
  if (cap !== undefined) n.capacity_cost = cap;
  return n;
}
function flow(id: string, value = 0): Node {
  return { id, label: id, type: "flow", initial_value: value, unit: "u" };
}
function edge(
  id: string,
  s: string,
  t: string,
  o: { pol?: "+" | "-"; mag?: number; str?: number } = {},
): Edge {
  const mag = o.mag ?? 0;
  return {
    id,
    source: s,
    target: t,
    polarity: o.pol ?? "+",
    delay: { type: mag === 0 ? "none" : "material", magnitude: mag },
    strength: o.str ?? 1,
  };
}

/** demand(180) -> A(stock, collar 100, cap 10) -> B(stock, collar 150, cap 10) -> exit. */
function fixtureMigration(): Graph {
  const g: Graph = {
    nodes: [
      flow("demand", 180),
      stock("a", 100, { lower: 0, upper: 100 }, 10),
      stock("b", 100, { lower: 0, upper: 150 }, 10),
      stock("exit", 0),
    ],
    edges: [edge("e1", "demand", "a"), edge("e2", "a", "b"), edge("e3", "b", "exit")],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[3].boundary = true;
  return withComputedLoops(g);
}

const ENGINE = DEFAULT_ENGINE_OPTIONS;
const WEIGHTS = DEFAULT_WEIGHTS;

// --- tray operations -------------------------------------------------------

describe("tray operations", () => {
  it("emptyTray has no cards and no chosen id", () => {
    const t = emptyTray();
    expect(t.cards).toEqual([]);
    expect(t.chosenId).toBeNull();
  });

  it("addCard appends without mutating the original", () => {
    const t = emptyTray();
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "2026-01-01T00:00:00Z",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const t2 = addCard(t, card);
    expect(t.cards).toHaveLength(0);
    expect(t2.cards).toHaveLength(1);
    expect(t2.cards[0]).toBe(card);
  });

  it("chooseCard marks the chosen id and clears it with null", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    let t: ScenarioTray = addCard(emptyTray(), card);
    t = chooseCard(t, "s1");
    expect(t.chosenId).toBe("s1");
    t = chooseCard(t, null);
    expect(t.chosenId).toBeNull();
  });

  it("chooseCard ignores an id not in the tray", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const t = chooseCard(addCard(emptyTray(), card), "does-not-exist");
    expect(t.chosenId).toBeNull();
  });

  it("removeCard drops a card and clears the chosen id if it was chosen", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    let t: ScenarioTray = addCard(emptyTray(), card);
    t = chooseCard(t, "s1");
    t = removeCard(t, "s1");
    expect(t.cards).toHaveLength(0);
    expect(t.chosenId).toBeNull();
  });

  it("nextScenarioId is sequential and skips taken ids", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const t = addCard(emptyTray(), card);
    expect(nextScenarioId(t)).toBe("s2");
    const t2 = addCard(t, { ...card, id: "s2" });
    expect(nextScenarioId(t2)).toBe("s3");
  });
});

// --- pinScenario -----------------------------------------------------------

describe("pinScenario", () => {
  it("is deterministic: same inputs -> same card (no robustness)", () => {
    const g = fixtureMigration();
    const iv: TypedIntervention = { type: "elevate", target: "a", magnitude: 50 };
    const a = pinScenario(g, iv, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const b = pinScenario(g, iv, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    expect(b).toEqual(a);
  });

  it("is deterministic with a seeded robustness run", () => {
    const g = fixtureMigration();
    const iv: TypedIntervention = { type: "elevate", target: "a", magnitude: 50 };
    const opts = {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
      robustnessN: 20,
      robustnessSeed: 42,
    };
    expect(pinScenario(g, iv, opts)).toEqual(pinScenario(g, iv, opts));
  });

  it("does not mutate the input graph", () => {
    const g = fixtureMigration();
    const before = JSON.stringify(g);
    pinScenario(g, { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    expect(JSON.stringify(g)).toBe(before);
  });

  it("captures ΔT/ΔOE, tier, dof, and constraint-after for an Elevate", () => {
    const g = fixtureMigration();
    // Elevate A's collar from 100 to 200 (above demand 180): A stops pinning
    // and B (collar 150) becomes the observed constraint (180 > 150).
    const card = pinScenario(g, { type: "elevate", target: "a", magnitude: 100 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    expect(card.tier).toBe(2); // Elevate = tier 2 (Bound)
    expect(card.deltaT).toBeGreaterThan(0);
    expect(card.deltaOE).toBeGreaterThan(0);
    expect(card.dT_dOE).not.toBeNull();
    expect(card.dof.total).toBe(g.nodes.length);
    expect(card.observedAfter).toBe("b");
  });

  it("omits robustnessVerdict when robustnessN is 0 (default)", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    expect(card.robustnessVerdict).toBeUndefined();
  });

  it("populates robustnessVerdict when robustnessN > 0", () => {
    const card = pinScenario(fixtureMigration(), { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
      robustnessN: 20,
      robustnessSeed: 42,
    });
    expect(card.robustnessVerdict).toBeDefined();
    expect(["stable", "likely", "unstable"]).toContain(card.robustnessVerdict);
  });

  it("scenarioLabel formats each intervention type", () => {
    const g = fixtureMigration();
    expect(scenarioLabel(g, { type: "exploit", target: "a", magnitude: 20 })).toBe("Exploit on a (Δ20)");
    expect(scenarioLabel(g, { type: "elevate", target: "a", magnitude: 50 })).toBe("Elevate on a (Δ50)");
    expect(
      scenarioLabel(g, { type: "subordinate", target: "a", magnitude: 1, rope: { buffer: "b", release: "demand" } }),
    ).toContain("Subordinate");
    expect(
      scenarioLabel(g, { type: "structural", target: "a", magnitude: 0, edit: { kind: "collapseDelay", edgeId: "e2", factor: 0.5 } }),
    ).toContain("Collapse delay");
  });
});

// --- mermaid ---------------------------------------------------------------

describe("graphToMermaid", () => {
  it("emits a flowchart TD with every node and edge", () => {
    const g = fixtureMigration();
    const m = graphToMermaid(g);
    expect(m.startsWith("flowchart TD")).toBe(true);
    // Each node id appears as a mermaid id (prefixed n_).
    for (const n of g.nodes) {
      expect(m).toContain(`n_${n.id}`);
    }
    // Each edge rendered as an arrow.
    expect(m.split("\n").filter((l) => l.includes("-->")).length).toBe(g.edges.length);
  });

  it("labels edges with polarity and delay magnitude", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), stock("a", 0, { lower: 0, upper: 100 })],
      edges: [edge("e1", "demand", "a", { pol: "+", mag: 2 })],
      loops: [],
    };
    g.nodes[0].boundary = true;
    const m = graphToMermaid(withComputedLoops(g));
    expect(m).toContain("+");
    expect(m).toContain("2");
    expect(m).toContain("material");
  });

  it("uses distinct shapes per node type", () => {
    const g: Graph = {
      nodes: [
        { id: "s", label: "S", type: "stock", initial_value: 0, unit: "u" },
        { id: "f", label: "F", type: "flow", initial_value: 0, unit: "u" },
        { id: "x", label: "X", type: "auxiliary", initial_value: 0, unit: "u" },
      ],
      edges: [],
      loops: [],
    };
    const m = graphToMermaid(g);
    expect(m).toContain('["'); // stock rectangle
    expect(m).toContain('("'); // flow rounded
    expect(m).toContain('{{"'); // auxiliary hexagon
  });

  it("sanitises ids that start with a digit", () => {
    const g: Graph = {
      nodes: [{ id: "1demand", label: "Demand", type: "flow", initial_value: 0, unit: "u" }],
      edges: [],
      loops: [],
    };
    const m = graphToMermaid(g);
    expect(m).toContain("n__1demand");
  });
});

// --- export ----------------------------------------------------------------

describe("exportDecisionRecord", () => {
  it("produces all six ADR sections and a fenced mermaid block", () => {
    const g = fixtureMigration();
    const card = pinScenario(g, { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "2026-01-01T00:00:00Z",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const tray: ScenarioTray = chooseCard(addCard(emptyTray(), card), "s1");
    const md = exportDecisionRecord(g, tray, {
      weights: WEIGHTS,
      engine: ENGINE,
      steps: 300,
      generatedAt: "2026-01-02T00:00:00Z",
      toolVersion: "1.0",
      robustnessN: 0,
    });
    expect(md).toContain("# Decision Record");
    expect(md).toContain("## 1. Context");
    expect(md).toContain("## 2. Constraint identified");
    expect(md).toContain("## 3. Options considered");
    expect(md).toContain("## 4. Decision");
    expect(md).toContain("## 5. Consequences");
    expect(md).toContain("## 6. Provenance");
    expect(md).toContain("```mermaid");
    // The chosen scenario is named in the Decision section.
    expect(md).toContain("**Chosen: s1");
    // The comparison table has a row per card.
    expect(md).toContain("T2 Bound");
  });

  it("is pure: same inputs -> identical output", () => {
    const g = fixtureMigration();
    const card = pinScenario(g, { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "t",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
    });
    const tray = addCard(emptyTray(), card);
    const opts = {
      weights: WEIGHTS,
      engine: ENGINE,
      steps: 300,
      generatedAt: "2026-01-02T00:00:00Z",
      toolVersion: "1.0",
      robustnessN: 0,
    };
    expect(exportDecisionRecord(g, tray, opts)).toBe(exportDecisionRecord(g, tray, opts));
  });

  it("includes the node table with collars in physical units", () => {
    const g = fixtureMigration();
    const md = exportDecisionRecord(g, emptyTray(), {
      weights: WEIGHTS,
      engine: ENGINE,
      steps: 300,
      generatedAt: "t",
      robustnessN: 0,
    });
    expect(md).toContain("upper 100");
    expect(md).toContain("upper 150");
  });

  it("renders an empty-options notice when no scenarios are pinned", () => {
    const md = exportDecisionRecord(fixtureMigration(), emptyTray(), {
      weights: WEIGHTS,
      engine: ENGINE,
      steps: 300,
      generatedAt: "t",
      robustnessN: 0,
    });
    expect(md).toContain("No scenarios pinned");
  });
});

// --- session round-trip with the tray (spec §9.3) -------------------------

describe("session round-trip with scenario tray", () => {
  it("is lossless: load(save(graph, weights, tray)).tray equals the tray", () => {
    const g = fixtureMigration();
    const card = pinScenario(g, { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "2026-01-01T00:00:00Z",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
      robustnessN: 20,
      robustnessSeed: 42,
    });
    const tray = chooseCard(addCard(emptyTray(), card), "s1");
    const json = saveSession(g, WEIGHTS, tray);
    const loaded = loadSession(json);
    expect(loaded.tray).toBeDefined();
    expect(loaded.tray!.cards).toEqual(tray.cards);
    expect(loaded.tray!.chosenId).toBe("s1");
  });

  it("export -> import -> export is identical", () => {
    const g = fixtureMigration();
    const card = pinScenario(g, { type: "elevate", target: "a", magnitude: 50 }, {
      id: "s1",
      pinnedAt: "2026-01-01T00:00:00Z",
      engine: ENGINE,
      steps: 300,
      weights: WEIGHTS,
      robustnessN: 20,
      robustnessSeed: 42,
    });
    const tray = chooseCard(addCard(emptyTray(), card), "s1");
    const json1 = saveSession(g, WEIGHTS, tray);
    const loaded = loadSession(json1);
    const json2 = saveSession(loaded.graph, loaded.weights, loaded.tray ?? emptyTray());
    // savedAt differs (fresh timestamp), so normalise it before comparing.
    const norm = (s: string) => s.replace(/"savedAt":\s*"[^"]*"/g, '"savedAt":""');
    expect(norm(json2)).toBe(norm(json1));
  });

  it("loads an older session without a tray as an empty tray", () => {
    const g = fixtureMigration();
    // Hand-rolled v1 session JSON with no tray field.
    const json = JSON.stringify({ version: 1, graph: g, weights: WEIGHTS, savedAt: "t" });
    const loaded = loadSession(json);
    expect(loaded.tray).toBeDefined();
    expect(loaded.tray!.cards).toEqual([]);
    expect(loaded.tray!.chosenId).toBeNull();
  });
});
