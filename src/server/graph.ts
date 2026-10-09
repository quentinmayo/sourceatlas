import type { Asset, Graph } from './model.js';
const lineageTypes = new Set(['CONTAINS', 'BUILT_AS', 'DEPLOYED_AS']);
export function lineage(graph: Graph, id: string): Graph {
  const selected = new Set([id]);
  function walk(direction: 'source' | 'target') {
    const queue = [id],
      seen = new Set(queue),
      other = direction === 'source' ? 'target' : 'source';
    while (queue.length) {
      const current = queue.shift()!;
      for (const link of graph.links)
        if (
          (lineageTypes.has(link.type) ||
            (direction === 'target' &&
              current === id &&
              ['RUNS_IN', 'STORED_IN'].includes(link.type))) &&
          link[direction] === current &&
          !seen.has(link[other])
        ) {
          seen.add(link[other]);
          selected.add(link[other]);
          queue.push(link[other]);
        }
    }
  }
  walk('source');
  walk('target');
  for (const link of graph.links)
    if (['RUNS_IN', 'STORED_IN'].includes(link.type) && selected.has(link.source))
      selected.add(link.target);
  return {
    assets: graph.assets.filter((a) => selected.has(a.id)),
    links: graph.links.filter((l) => selected.has(l.source) && selected.has(l.target)),
  };
}
export type Finding = { id: string; severity: string; title: string; detail: string; asset: Asset };
export function findings(graph: Graph, now = Date.now()): Finding[] {
  const result: Finding[] = [];
  for (const a of graph.assets.filter((a) => a.type === 'WORKLOAD')) {
    const path = lineage(graph, a.id);
    if (!a.digest)
      result.push({
        id: a.id + ':digest',
        severity: 'HIGH',
        title: 'Unresolved runtime image',
        detail: 'The runtime did not report an immutable digest. Source attribution is unknown.',
        asset: a,
      });
    else if (!path.assets.some((a) => a.type === 'DOCKERFILE'))
      result.push({
        id: a.id + ':source',
        severity: 'HIGH',
        title: 'Missing build provenance',
        detail: 'This running image has no recorded repository, commit, and Dockerfile.',
        asset: a,
      });
    if (!a.owner && !path.assets.some((a) => a.type === 'REPOSITORY' && a.owner))
      result.push({
        id: a.id + ':owner',
        severity: 'MEDIUM',
        title: 'No accountable owner',
        detail: 'Assign an owner in build metadata or on the runtime workload.',
        asset: a,
      });
    if (now - Date.parse(a.observedAt) > 24 * 60 * 60 * 1000)
      result.push({
        id: a.id + ':stale',
        severity: 'LOW',
        title: 'Stale runtime observation',
        detail:
          'This workload has not been observed for more than 24 hours. It may no longer be running.',
        asset: a,
      });
  }
  return result;
}
