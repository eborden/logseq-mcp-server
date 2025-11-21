import { expect } from 'vitest';

/**
 * Assert that there are no duplicate IDs in the nodes array
 */
export function assertNoNodeDuplicates(nodes: Array<{ id: number }>) {
  const ids = nodes.map(n => n.id);
  const uniqueIds = new Set(ids);
  expect(ids.length).toBe(uniqueIds.size);
}

/**
 * Assert that all edges reference valid node IDs
 */
export function assertReferentialIntegrity(
  nodes: Array<{ id: number }>,
  edges: Array<{ from: number; to: number }>
) {
  const nodeIds = new Set(nodes.map(n => n.id));

  for (const edge of edges) {
    expect(nodeIds.has(edge.from)).toBe(true);
    expect(nodeIds.has(edge.to)).toBe(true);
  }
}

/**
 * Assert that depth increases monotonically along edges
 * For each edge (from -> to), depth(to) <= depth(from) + 1
 */
export function assertDepthMonotonic(
  nodes: Array<{ id: number; depth: number }>,
  edges: Array<{ from: number; to: number }>
) {
  const depthMap = new Map(nodes.map(n => [n.id, n.depth]));

  for (const edge of edges) {
    const fromDepth = depthMap.get(edge.from);
    const toDepth = depthMap.get(edge.to);

    if (fromDepth !== undefined && toDepth !== undefined) {
      expect(toDepth).toBeLessThanOrEqual(fromDepth + 1);
    }
  }
}

/**
 * Assert that all nodes are reachable from root via edges
 * (Graph is connected)
 */
export function assertConnectedGraph(
  rootId: number,
  nodes: Array<{ id: number }>,
  edges: Array<{ from: number; to: number }>
) {
  if (nodes.length <= 1) {
    // Single node graph is trivially connected
    return;
  }

  // Build adjacency list (undirected)
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }

  // BFS from root
  const visited = new Set<number>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) || [];

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // All nodes should be visited
  expect(visited.size).toBe(nodes.length);
}

/**
 * Assert that a set is a subset of another set
 */
export function assertSubset<T>(subset: Set<T>, superset: Set<T>) {
  for (const item of subset) {
    expect(superset.has(item)).toBe(true);
  }
}

/**
 * Assert that dates are sorted in ascending order
 */
export function assertDatesSorted(dates: number[]) {
  for (let i = 1; i < dates.length; i++) {
    expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
  }
}

/**
 * Assert that all dates fall within a specified range
 */
export function assertDatesInRange(dates: number[], startDate: number, endDate: number) {
  for (const date of dates) {
    expect(date).toBeGreaterThanOrEqual(startDate);
    expect(date).toBeLessThanOrEqual(endDate);
  }
}

/**
 * Assert that count summaries match actual data
 */
export function assertCountsMatch(
  summary: { totalBlocks: number; totalRelatedPages: number; totalReferences: number },
  actual: { blocks: any[]; relatedPages: any[]; references: any[] }
) {
  expect(summary.totalBlocks).toBe(actual.blocks.length);
  expect(summary.totalRelatedPages).toBe(actual.relatedPages.length);
  expect(summary.totalReferences).toBe(actual.references.length);
}
