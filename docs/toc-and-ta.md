# Theory of Constraints and Throughput Accounting

This document explains the ideas behind Layer 2 and Layer 3, and how they map
to the two lenses Layers borrows from ToC: the **Five Focusing Steps** and
**Throughput Accounting**.

---

## The Five Focusing Steps

Goldratt's Five Focusing Steps are a decision loop, not a one-time analysis:

1. **Identify** the system's constraint — the one resource or node that limits
   the whole system's output.
2. **Exploit** the constraint — get everything you can from it without spending
   more. Use idle capacity, reduce waste at that node, eliminate non-value work
   that consumes constraint time.
3. **Subordinate** everything else to the constraint — align every other part
   of the system to feed and protect the constraint. Do not optimise non-
   constraint nodes in ways that starve or overwhelm it.
4. **Elevate** the constraint — if the first three steps are exhausted and the
   constraint still limits the goal, invest to increase its capacity.
5. **Repeat** — once the constraint is broken, it moves. Go back to step 1.

Steps 2–3 *precede* Step 4 deliberately. Elevating before exploiting is waste:
you pay for capacity you did not yet fully use. Layers enforces this ordering by
capping the Exploit slider at available headroom and disabling it at zero headroom,
making the case for Elevate legible only when headroom is genuinely exhausted.

---

## How each step maps to a collar operation

Physical collars — bounds on a node's value in the node's own units — give each
step an exact computational definition.

| Step | Collar operation | What changes | Expected TA signature |
|---|---|---|---|
| **Exploit** | Close the gap between the current operating point and the *existing* upper collar. The collar does not move. | Operating point ↑ | T ↑, OE flat, I flat or ↓ |
| **Subordinate** | Add a negative-polarity information edge from a downstream buffer back to an upstream release flow (a *rope*). | Topology | I ↓ sharply, T ~flat, OE flat |
| **Elevate** | Move the upper collar up; the node's `capacity_cost` is scaled proportionally so OE rises. | Collar bound ↑, OE ↑ | T ↑, OE ↑, I ↑ |

A collar that does not change a trajectory is not implemented correctly. The
whole point of physical collars is that "this node cannot go there" is a
dynamical claim, not a display range.

---

## Throughput Accounting

T/I/OE are derived from the system boundary and topology, not hand-annotated.

| Measure | Definition |
|---|---|
| **T — Throughput** | Rate of flow across the system's exit boundary, multiplied by the contribution margin. What the system produces for its environment per unit of time. |
| **I — Investment / Inventory** | Total stock mass *plus* material in-flight in delay queues inside the system. In-flight material is tied-up capital; excluding it understates WIP and breaks the conservation invariant. |
| **OE — Operating Expense** | Flow through constrained resources inside the system — the cost of having capacity, regardless of utilisation. Declared via `capacity_cost` on collared nodes. |

The key insight is that T, I, and OE are in conflict when the constraint
binds: raising T through Exploit may reduce I (less queuing); Elevate raises T
and OE together. This tension is what makes TA useful — it surfaces the
*cost* of each move, not just the direction.

---

## Why Exploit and Subordinate come before Elevate

Elevate is irreversible in the short run. You hire staff, buy equipment, or add
infrastructure. If the constraint moves after elevation (Step 5), you now carry
OE at a node that is no longer the constraint.

Exploit is reversible and free by definition — it uses what already exists.
Subordinate is structural but cheap — a WIP limit, a pull-based queue, a
merge-gate.

Layers makes this concrete: the Exploit slider is *capped at available headroom*.
If `production_capacity` is running at 96 units/week against a collar of 100,
headroom is 4%. The slider stops there and shows: *"Only 4% headroom remains.
Further gain requires Elevate."* A node pinned 100% of the run has zero headroom;
Exploit is disabled entirely.

This is the discipline made mechanical. The user arrives at Elevate because the
tool shows them they have exhausted the alternatives — rather than because they
assumed the constraint was a capacity problem before checking.

---

## Constraint migration and Step 5

After any intervention, Step 5 says: go back to Step 1. The constraint moves.

Layers tracks this as a migration trail: each intervention records
`(constraint_before, constraint_after, ΔT, ΔOE, ΔDoF)`. The trail is rendered
in Layer 2 as a dashed arc on the canvas from the previous constraint to the new
one, faded by recency.

If the constraint returns to a node already in the trail, a cycle is flagged:

> *"Cycle detected: two elevations, net ΔT ≈ 0, ΔOE +X. The constraint returned
> to where it started."*

This is the exact failure mode that ToC's repeat step is designed to surface. Two
elevations with no net throughput gain means you have been paying for capacity
without moving the system's real limit.

---

## Degrees of freedom

Every pinned node is a lost dimension. When `production_capacity` is pinned at
its upper collar, it has stopped responding to anything — its row in the system
Jacobian is zero. This is not a metaphor; it is the formal statement of
"constraint."

The DoF counter in the play bar — *"DoF: 5 of 8"* — shows how many nodes still
have room to respond. An architect watching this number fall as they add load is
watching the system's flexibility drain in real time.
