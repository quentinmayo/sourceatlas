import neo4j, { type Driver } from 'neo4j-driver';
import { type Asset, type Batch, type Graph, normalize } from './model.js';
export interface Store {
  read(): Promise<Graph>;
  ingest(batch: Batch): Promise<void>;
  close(): Promise<void>;
}
export class MemoryStore implements Store {
  private graph: Graph = { assets: [], links: [] };
  private clocks = new Map<string, string>();
  async read() {
    return structuredClone(this.graph);
  }
  async ingest(batch: Batch) {
    const clockKey = batch.kind + ':' + batch.scope;
    if ((this.clocks.get(clockKey) ?? '') > batch.observedAt)
      throw new Error('Stale snapshot rejected');
    const next = normalize(batch),
      assets = new Map(this.graph.assets.map((a) => [a.id, a])),
      links = new Map(this.graph.links.map((l) => [l.id, l]));
    const incoming = new Set(next.assets.filter((a) => a.type === 'WORKLOAD').map((a) => a.id));
    if (batch.kind === 'WORKLOAD') {
      for (const a of assets.values())
        if (
          a.type === 'WORKLOAD' &&
          a.scope === batch.scope &&
          (batch.complete || incoming.has(a.id))
        ) {
          assets.delete(a.id);
          for (const [id, l] of links) if (l.source === a.id || l.target === a.id) links.delete(id);
        }
    }
    for (const a of next.assets) {
      const old = assets.get(a.id);
      if (!old || old.observedAt <= a.observedAt)
        assets.set(a.id, {
          ...old,
          ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
        } as Asset);
    }
    for (const l of next.links)
      if (!links.has(l.id) || links.get(l.id)!.observedAt <= l.observedAt) links.set(l.id, l);
    this.graph = { assets: [...assets.values()], links: [...links.values()] };
    this.clocks.set(clockKey, batch.observedAt);
  }
  async close() {}
}
export class Neo4jStore implements Store {
  constructor(
    private driver: Driver,
    private database = 'neo4j',
  ) {}
  async initialize() {
    await this.driver.verifyConnectivity();
    for (const label of ['Asset', 'Snapshot'])
      await this.driver.executeQuery(
        `CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (a:${label}) REQUIRE a.id IS UNIQUE`,
        {},
        { database: this.database },
      );
  }
  async ingest(batch: Batch) {
    const graph = normalize(batch),
      session = this.driver.session({ database: this.database });
    try {
      await session.executeWrite(async (tx) => {
        // Acquiring a write lock serializes updates to the same collector scope.
        const result = await tx.run(
          'MERGE (s:Snapshot {id:$id}) SET s.lock = coalesce(s.lock,0)+1 RETURN s.observedAt AS observedAt',
          { id: batch.kind + ':' + batch.scope },
        );
        if ((result.records[0].get('observedAt') ?? '') > batch.observedAt)
          throw new Error('Stale snapshot rejected');
        if (batch.kind === 'WORKLOAD')
          await tx.run(
            'MATCH (a:Asset {type:"WORKLOAD", scope:$scope}) WHERE $complete OR a.id IN $ids DETACH DELETE a',
            {
              scope: batch.scope,
              complete: batch.complete,
              ids: graph.assets.filter((a) => a.type === 'WORKLOAD').map((a) => a.id),
            },
          );
        await tx.run(
          'UNWIND $assets AS item MERGE (a:Asset {id:item.id}) WITH a,item WHERE a.observedAt IS NULL OR a.observedAt <= item.observedAt SET a += item',
          {
            assets: graph.assets.map((a) =>
              Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
            ),
          },
        );
        await tx.run(
          'UNWIND $links AS item MATCH (a:Asset {id:item.source}), (b:Asset {id:item.target}) MERGE (a)-[r:RELATES {id:item.id}]->(b) WITH r,item WHERE r.observedAt IS NULL OR r.observedAt <= item.observedAt SET r += item',
          { links: graph.links },
        );
        await tx.run('MATCH (s:Snapshot {id:$id}) SET s.observedAt=$observedAt', {
          id: batch.kind + ':' + batch.scope,
          observedAt: batch.observedAt,
        });
      });
    } finally {
      await session.close();
    }
  }
  async read(): Promise<Graph> {
    const session = this.driver.session({ database: this.database });
    try {
      return await session.executeRead(async (tx) => {
        const a = await tx.run('MATCH (a:Asset) RETURN properties(a) AS item LIMIT 20001');
        if (a.records.length > 20000)
          throw new Error('Inventory exceeds MVP limit of 20,000 assets');
        const l = await tx.run(
          'MATCH (:Asset)-[r:RELATES]->(:Asset) RETURN properties(r) AS item LIMIT 100001',
        );
        if (l.records.length > 100000)
          throw new Error('Inventory exceeds MVP limit of 100,000 relationships');
        return {
          assets: a.records.map((r) => r.get('item')),
          links: l.records.map((r) => r.get('item')),
        };
      });
    } finally {
      await session.close();
    }
  }
  async close() {
    await this.driver.close();
  }
}
export function createNeo4jStore() {
  if (!process.env.NEO4J_PASSWORD) throw new Error('NEO4J_PASSWORD is required');
  return new Neo4jStore(
    neo4j.driver(
      process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687',
      neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD),
    ),
    process.env.NEO4J_DATABASE ?? 'neo4j',
  );
}
