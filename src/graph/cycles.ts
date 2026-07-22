/**
 * Elementary cycle enumeration via Johnson's algorithm.
 *
 * Per the spec (§2): cycles are found via Johnson's algorithm (or simple DFS for
 * graphs under ~50 nodes). Johnson's algorithm runs in O((n+e)(c+1)) time where
 * c is the number of elementary cycles — optimal for finding all simple cycles
 * in a directed graph. This module is pure, framework-agnostic, and the sole
 * feedstock for `src/graph/loops.ts` which derives `Loop[]` from a `Graph`.
 *
 * Each returned cycle is an ordered list of node ids [v0, v1, ..., vk] where an
 * edge exists v0->v1->...->vk->v0. The cycle is reported starting from its
 * lowest-indexed node (by input order) so each elementary cycle appears exactly
 * once regardless of traversal direction.
 */

/** A directed adjacency map: node id -> list of successor node ids. */
export type Adjacency = Map<string, string[]>;

/**
 * Find all elementary (simple) cycles in a directed graph.
 *
 * @param nodeIds  ordered list of node ids (defines index ordering for the
 *                 canonical start-node choice that deduplicates cycles).
 * @param adj      adjacency map (must contain every node id as a key; extra
 *                 successors referencing unknown nodes are ignored).
 * @returns list of cycles, each an ordered array of node ids with an implicit
 *          closing edge from the last element back to the first.
 */
export function findCycles(nodeIds: string[], adj: Adjacency): string[][] {
  // Map each node id to a stable integer index. Johnson's algorithm iterates
  // over components induced by {nodes with index >= s}, so the index order
  // determines which node "owns" each cycle (the lowest-indexed member).
  const index = new Map<string, number>();
  for (let i = 0; i < nodeIds.length; i++) index.set(nodeIds[i], i);

  // Only consider edges between known nodes to stay robust to malformed input.
  // Self-loops are excluded: the model rejects self-loop edges (edge_self_loop),
  // and an elementary cycle of length 1 is not meaningful in a CLD.
  const adjFiltered: Adjacency = new Map();
  for (const id of nodeIds) {
    const succ = adj.get(id) ?? [];
    adjFiltered.set(
      id,
      succ.filter((t) => index.has(t) && t !== id),
    );
  }

  const cycles: string[][] = [];

  for (let startIdx = 0; startIdx < nodeIds.length; startIdx++) {
    const s = nodeIds[startIdx];

    // Build the subgraph induced by nodes with index >= startIdx, then restrict
    // to the strongly connected component containing s. Nodes outside this SCC
    // cannot participate in a cycle through s.
    const subNodes = nodeIds.slice(startIdx);
    const sccs = stronglyConnectedComponents(subNodes, adjFiltered);
    const scc = sccs.find((c) => c.has(s));
    if (!scc || scc.size < 1) continue;

    // Per-start-node blocking state. `blocked` marks nodes on the current
    // recursion stack region that should not be revisited; `blockList[w]` lists
    // nodes that must be unblocked iff `w` is unblocked — Johnson's key pruning
    // that keeps the algorithm polynomial.
    const blocked = new Set<string>();
    const blockList = new Map<string, Set<string>>();
    const stack: string[] = [];

    johnsonDFS(s, s, adjFiltered, scc, blocked, blockList, stack, cycles);
  }

  return cycles;
}

/**
 * Recursive core of Johnson's algorithm. Walks paths from `start` (= the least
 * index in the current SCC); whenever an edge back to `start` is found, the
 * current stack plus the closing edge forms an elementary cycle.
 */
function johnsonDFS(
  start: string,
  node: string,
  adj: Adjacency,
  scc: Set<string>,
  blocked: Set<string>,
  blockList: Map<string, Set<string>>,
  stack: string[],
  out: string[][],
): void {
  stack.push(node);
  blocked.add(node);

  const successors = (adj.get(node) ?? []).filter((t) => scc.has(t));
  for (const w of successors) {
    if (w === start) {
      // Found a cycle: the path on the stack closes back to `start`.
      out.push([...stack]);
    } else if (!blocked.has(w)) {
      johnsonDFS(start, w, adj, scc, blocked, blockList, stack, out);
    } else {
      // `w` is blocked on this path; remember that unblocking `w` later must
      // also unblock `node` (transitive dependency — Johnson's B-list).
      recordDependency(blockList, w, node);
    }
  }

  // Done exploring from `node` along this path. Unblock it and transitively
  // any nodes blocked only because of it.
  unblock(node, blocked, blockList);
  stack.pop();
}

function recordDependency(
  blockList: Map<string, Set<string>>,
  blocked: string,
  dependsOn: string,
): void {
  let deps = blockList.get(blocked);
  if (!deps) {
    deps = new Set();
    blockList.set(blocked, deps);
  }
  deps.add(dependsOn);
}

function unblock(node: string, blocked: Set<string>, blockList: Map<string, Set<string>>): void {
  const deps = blockList.get(node);
  if (deps) {
    // Snapshot to a plain array so iteration survives mutation during recursion.
    for (const d of [...deps]) {
      if (blocked.has(d)) unblock(d, blocked, blockList);
    }
    deps.clear();
    blockList.delete(node);
  }
  blocked.delete(node);
}

/**
 * Compute strongly connected components of the subgraph induced by `subNodes`
 * (Tarjan's algorithm). Returns a list of component node-sets. A node with no
 * return path forms a singleton SCC that cannot host a cycle; callers ignore
 * such components via the size check.
 */
function stronglyConnectedComponents(subNodes: string[], adj: Adjacency): Set<string>[] {
  // Restrict adjacency to the induced subgraph.
  const subSet = new Set(subNodes);
  const localAdj: Adjacency = new Map();
  for (const id of subNodes) {
    localAdj.set(
      id,
      (adj.get(id) ?? []).filter((t) => subSet.has(t)),
    );
  }

  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const components: Set<string>[] = [];

  function strongconnect(v: string): void {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of localAdj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }

    if (low.get(v) === idx.get(v)) {
      const comp = new Set<string>();
      let u: string;
      do {
        u = stack.pop()!;
        onStack.delete(u);
        comp.add(u);
      } while (u !== v);
      components.push(comp);
    }
  }

  for (const v of subNodes) {
    if (!idx.has(v)) strongconnect(v);
  }

  return components;
}
