import { batchSchema } from './model.js';
import type { Store } from './store.js';
export async function seedDemo(store: Store) {
  const now = new Date().toISOString(),
    registry = '123456789012.dkr.ecr.us-east-1.amazonaws.com';
  const services = [
    ['payments-api', 'commerce', 'a', 'KUBERNETES', 'production-us'],
    ['checkout-web', 'commerce', 'b', 'KUBERNETES', 'production-us'],
    ['identity-service', 'platform', 'c', 'ECS', 'production-eu'],
    ['event-worker', 'data-platform', 'd', 'ECS', 'staging-us'],
    ['notifications', 'platform', 'e', 'KUBERNETES', 'staging-us'],
  ];
  for (const [name, owner, char, platform, environment] of services) {
    const digest = 'sha256:' + char.repeat(64),
      image = registry + '/' + name;
    await store.ingest(
      batchSchema.parse({
        scope: 'demo-builds',
        kind: 'BUILD',
        observedAt: now,
        builds: [
          {
            repository: 'https://github.com/example/' + name,
            revision: char.repeat(40),
            dockerfile: 'Dockerfile',
            image,
            digest,
            owner,
            buildUrl: 'https://github.com/example/' + name + '/actions/runs/100',
            observedAt: now,
          },
        ],
      }),
    );
    await store.ingest(
      batchSchema.parse({
        scope: 'demo-runtime',
        kind: 'WORKLOAD',
        observedAt: now,
        workloads: [
          {
            uid: name,
            name: name + ' / app',
            platform,
            environment,
            image,
            digest,
            imageReference: image + ':v1.4.2',
            owner,
            namespace: platform === 'KUBERNETES' ? 'apps' : undefined,
            observedAt: now,
          },
        ],
      }),
    );
  }
  await store.ingest(
    batchSchema.parse({
      scope: 'demo-runtime',
      kind: 'WORKLOAD',
      observedAt: now,
      workloads: [
        {
          uid: 'legacy',
          name: 'legacy-exporter / app',
          platform: 'ECS',
          environment: 'production-us',
          image: registry + '/legacy-exporter',
          digest: 'sha256:' + 'f'.repeat(64),
          imageReference: registry + '/legacy-exporter:latest',
          observedAt: now,
        },
        {
          uid: 'sandbox',
          name: 'sandbox-runner / app',
          platform: 'KUBERNETES',
          environment: 'development',
          image: 'docker.io/library/alpine',
          imageReference: 'alpine:latest',
          namespace: 'sandbox',
          observedAt: now,
        },
      ],
    }),
  );
}
