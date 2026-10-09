import test from 'node:test';
import assert from 'node:assert/strict';
import { batchSchema, imageId } from '../src/server/model.js';
import { MemoryStore } from '../src/server/store.js';
import { findings, lineage } from '../src/server/graph.js';
import { createApi } from '../src/server/api.js';
import { kubernetesSnapshot, parseImage, runtimeDigest } from '../src/collectors/normalize.js';
const now = '2026-01-02T00:00:00.000Z',
  earlier = '2026-01-01T00:00:00.000Z';
const image = '123.dkr.ecr.us-east-1.amazonaws.com/api',
  digest = 'sha256:' + 'a'.repeat(64);
const build = {
  repository: 'https://github.com/example/api.git',
  revision: 'a'.repeat(40),
  dockerfile: 'Dockerfile',
  image,
  digest,
  owner: 'platform',
  observedAt: now,
};
const workload = {
  uid: 'pod/app',
  name: 'api/app',
  platform: 'KUBERNETES',
  environment: 'production',
  image,
  digest,
  imageReference: image + ':latest',
  observedAt: now,
};
const builds = (items = [build]) =>
  batchSchema.parse({ scope: 'ci', kind: 'BUILD', observedAt: now, builds: items });
const runtime = (
  items: unknown[] = [workload],
  complete = true,
  scope = 'cluster',
  observedAt = now,
) => batchSchema.parse({ scope, kind: 'WORKLOAD', complete, observedAt, workloads: items });
async function seeded() {
  const store = new MemoryStore();
  await store.ingest(builds());
  await store.ingest(runtime());
  return store;
}
test('traces a repository and versioned Dockerfile to a digest and running workload', async () => {
  const g = await (await seeded()).read(),
    repo = g.assets.find((a) => a.type === 'REPOSITORY')!;
  const path = lineage(g, repo.id);
  assert.equal(path.assets.filter((a) => a.type === 'WORKLOAD').length, 1);
  assert.ok(path.links.some((l) => l.type === 'BUILT_AS'));
  assert.equal(findings(g, Date.parse(now)).length, 0);
});
test('ingestion is idempotent', async () => {
  const store = await seeded(),
    before = await store.read();
  await store.ingest(builds());
  await store.ingest(runtime());
  const after = await store.read();
  const sort = (g: typeof before) => ({
    assets: g.assets.sort((a, b) => a.id.localeCompare(b.id)),
    links: g.links.sort((a, b) => a.id.localeCompare(b.id)),
  });
  assert.deepEqual(sort(after), sort(before));
});
test('mutable tags never establish source attribution', async () => {
  const store = await seeded();
  await store.ingest(runtime([{ ...workload, digest: undefined }]));
  const g = await store.read();
  assert.ok(findings(g, Date.parse(now)).some((f) => f.title === 'Unresolved runtime image'));
  assert.equal(g.links.filter((l) => l.type === 'DEPLOYED_AS').length, 0);
});
test('different digest or registry never links to a known build', async () => {
  const store = await seeded();
  await store.ingest(
    runtime([
      { ...workload, digest: 'sha256:' + 'b'.repeat(64) },
      { ...workload, uid: 'second', image: 'other.example.com/api' },
    ]),
  );
  const g = await store.read();
  assert.equal(
    findings(g, Date.parse(now)).filter((f) => f.title === 'Missing build provenance').length,
    2,
  );
});
test('lineage does not cross into unrelated assets sharing an environment or registry', async () => {
  const store = await seeded();
  await store.ingest(
    runtime([{ ...workload, uid: 'other', image: 'other.example.com/unrelated' }], false),
  );
  const g = await store.read(),
    repo = g.assets.find((a) => a.type === 'REPOSITORY')!;
  assert.equal(lineage(g, repo.id).assets.filter((a) => a.type === 'WORKLOAD').length, 1);
  const env = g.assets.find((a) => a.type === 'ENVIRONMENT')!;
  assert.equal(lineage(g, env.id).assets.filter((a) => a.type === 'WORKLOAD').length, 2);
});
test('reconciliation removes absent workloads only in its own scope', async () => {
  const store = await seeded();
  await store.ingest(runtime([workload], true, 'second-cluster'));
  await store.ingest(runtime([]));
  const g = await store.read();
  assert.equal(g.assets.filter((a) => a.type === 'WORKLOAD').length, 1);
  assert.equal(g.assets.filter((a) => a.type === 'DOCKERFILE').length, 1);
});
test('updating a workload removes its previous image relationship', async () => {
  const store = await seeded();
  await store.ingest(runtime([{ ...workload, digest: 'sha256:' + 'c'.repeat(64) }], false));
  const g = await store.read();
  assert.equal(g.links.filter((l) => l.type === 'DEPLOYED_AS').length, 1);
  assert.equal(
    g.links.find((l) => l.type === 'DEPLOYED_AS')?.source,
    imageId(image, 'sha256:' + 'c'.repeat(64)),
  );
});
test('stale snapshots cannot erase a newer inventory', async () => {
  const store = await seeded(),
    before = await store.read();
  await assert.rejects(store.ingest(runtime([], true, 'cluster', earlier)), /Stale/);
  assert.deepEqual(await store.read(), before);
});
test('validates digests, revisions, duplicate identities and snapshot time consistency', () => {
  assert.throws(() => builds([{ ...build, digest: 'latest' }]));
  assert.throws(() => builds([{ ...build, revision: 'main' }]));
  assert.throws(() => runtime([workload, workload]));
  assert.throws(() => runtime([{ ...workload, observedAt: earlier }]));
});
test('image parsing handles registry ports, Docker Hub, pinned references, and runtime schemes', () => {
  assert.deepEqual(parseImage('localhost:5000/api:latest'), {
    image: 'localhost:5000/api',
    digest: undefined,
  });
  assert.equal(parseImage('alpine:3').image, 'docker.io/library/alpine');
  assert.equal(parseImage('example/api:latest').image, 'docker.io/example/api');
  assert.equal(parseImage(image + '@' + digest).digest, digest);
  assert.equal(runtimeDigest('containerd://' + digest), digest);
  assert.equal(runtimeDigest('docker-pullable://' + image + '@' + digest), digest);
});
test('Kubernetes uses running container status, never desired spec digest', () => {
  const data = kubernetesSnapshot(
    [
      {
        metadata: { uid: 'pod', name: 'api' },
        spec: {
          containers: [
            { name: 'app', image: image + '@' + digest },
            { name: 'stopped', image: 'alpine' },
          ],
        },
        status: { phase: 'Running', containerStatuses: [{ name: 'app', state: { running: {} } }] },
      },
    ],
    'prod',
    'production',
    now,
  );
  assert.equal(data.workloads.length, 1);
  assert.equal(data.workloads[0].digest, undefined);
  assert.equal(data.complete, true);
});
test('stale observations are visible as findings', async () => {
  const g = await (await seeded()).read();
  assert.ok(
    findings(g, Date.parse(now) + 86400001).some((f) => f.title === 'Stale runtime observation'),
  );
});
async function request(
  api: ReturnType<typeof createApi>,
  query: string,
  token?: string,
  variables?: unknown,
) {
  const response = await api.fetch(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return (await response.json()) as any;
}
test('GraphQL requires auth and restricts mutations to collector token', async () => {
  const api = createApi(await seeded(), { demo: false, readToken: 'reader', writeToken: 'writer' });
  assert.ok((await request(api, '{summary{workloads}}')).errors);
  assert.equal((await request(api, '{summary{workloads}}', 'reader')).data.summary.workloads, 1);
  const mutation = 'mutation($batch:BatchInput!){ingest(batch:$batch){accepted}}';
  assert.ok((await request(api, mutation, 'reader', { batch: runtime([]) })).errors);
  assert.equal(
    (await request(api, mutation, 'writer', { batch: runtime([]) })).data.ingest.accepted,
    true,
  );
});
test('GraphQL search, pagination, lineage and validation work through the API', async () => {
  const store = await seeded(),
    api = createApi(store, { demo: true });
  const r = await request(
    api,
    '{assets(type:REPOSITORY,search:"example",limit:1){total items{id repository}}}',
  );
  assert.equal(r.data.assets.total, 1);
  assert.equal(r.data.assets.items[0].repository, 'https://github.com/example/api');
  const id = r.data.assets.items[0].id;
  assert.equal(
    (await request(api, 'query($id:ID!){lineage(id:$id){assets{id}}}', undefined, { id })).data
      .lineage.assets.length,
    6,
  );
  assert.ok((await request(api, '{assets(limit:501){total}}')).errors);
});
test('GraphQL rejects explosive named fragment expansion', async () => {
  const api = createApi(await seeded(), { demo: true });
  assert.ok((await request(api, '{...A} fragment A on Query { summary { workloads } }')).errors);
});
