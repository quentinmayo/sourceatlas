import test from 'node:test';
import assert from 'node:assert/strict';
import neo4j from 'neo4j-driver';
import { Neo4jStore } from '../src/server/store.js';
import { batchSchema } from '../src/server/model.js';
import { lineage } from '../src/server/graph.js';
test(
  'Neo4j persists native graph, survives reconnect, reconciles, and rolls back stale snapshots',
  { skip: process.env.NEO4J_TEST !== 'true' },
  async () => {
    const uri = process.env.NEO4J_URI ?? 'bolt://127.0.0.1:17687',
      auth = neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD ?? 'sourceatlas-test-password');
    const make = () => new Neo4jStore(neo4j.driver(uri, auth));
    // This test owns a dedicated disposable database; never point it at production.
    if (!/^bolt:\/\/127\.0\.0\.1:17687$/.test(uri))
      throw new Error('Integration test requires disposable localhost:17687 database');
    const driver = neo4j.driver(uri, auth);
    const existing = await driver.executeQuery('MATCH (n) RETURN count(n) AS count');
    assert.equal(
      existing.records[0].get('count').toNumber(),
      0,
      'Integration database must be empty',
    );
    let store = make();
    await store.initialize();
    const observedAt = '2026-01-02T00:00:00.000Z',
      image = 'example.com/api',
      digest = 'sha256:' + 'a'.repeat(64);
    try {
      await store.ingest(
        batchSchema.parse({
          scope: 'ci',
          kind: 'BUILD',
          observedAt,
          builds: [
            {
              repository: 'https://github.com/example/api',
              revision: 'a'.repeat(40),
              dockerfile: 'Dockerfile',
              image,
              digest,
              observedAt,
            },
          ],
        }),
      );
      const batch = batchSchema.parse({
        scope: 'cluster',
        kind: 'WORKLOAD',
        complete: true,
        observedAt,
        workloads: [
          {
            uid: 'pod/app',
            name: 'api',
            platform: 'KUBERNETES',
            environment: 'prod',
            image,
            digest,
            imageReference: image + ':latest',
            observedAt,
          },
        ],
      });
      await store.ingest(batch);
      await store.ingest(batch);
      await store.close();
      store = make();
      await store.initialize();
      const graph = await store.read();
      assert.equal(graph.assets.length, 6);
      assert.equal(graph.links.length, 5);
      const repo = graph.assets.find((a) => a.type === 'REPOSITORY')!;
      assert.equal(lineage(graph, repo.id).assets.length, 6);
      await assert.rejects(
        store.ingest({ ...batch, observedAt: '2026-01-01T00:00:00.000Z', workloads: [] }),
        /Stale/,
      );
      assert.equal((await store.read()).assets.length, 6);
      await store.ingest({ ...batch, workloads: [] });
      assert.equal((await store.read()).assets.filter((a) => a.type === 'WORKLOAD').length, 0);
    } finally {
      await store.close();
      await driver.executeQuery('MATCH (n) DETACH DELETE n');
      await driver.close();
    }
  },
);
