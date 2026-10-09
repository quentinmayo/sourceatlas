import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand } from '@aws-sdk/client-ecr';
import {
  ECSClient,
  ListClustersCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { batchSchema, type Batch, type Workload } from '../server/model.js';
import { kubernetesSnapshot, parseImage } from './normalize.js';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    context: { type: 'string' },
    cluster: { type: 'string' },
    environment: { type: 'string' },
    region: { type: 'string' },
    send: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const command = positionals[0];
if (values.help || !command) {
  console.log(`SourceAtlas collectors (read-only cloud access)
  npm run collect -- import --file examples/build.json [--send]
  npm run collect -- kubernetes --context CONTEXT --cluster UNIQUE_CLUSTER_ID --environment production [--send]
  npm run collect -- kubernetes --file pods.json --cluster UNIQUE_CLUSTER_ID --environment production [--send]
  npm run collect -- ecr --region us-east-1 [--send]
  npm run collect -- ecs --region us-east-1 --environment production [--send]
Without --send, outputs JSON batches (one per line). Sending uses SOURCEATLAS_URL and WRITE_TOKEN.
Use one account/region/environment per invocation; scope IDs must remain stable.`);
  process.exit(0);
}
function required(value: string | undefined, name: string) {
  if (!value) throw new Error('--' + name + ' is required');
  return value;
}
async function emit(batch: Batch) {
  if (!values.send) {
    console.log(JSON.stringify(batch));
    return;
  }
  const url = process.env.SOURCEATLAS_URL ?? 'http://127.0.0.1:4000/graphql';
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  )
    throw new Error('Use HTTPS for a remote ingestion endpoint');
  if (!process.env.WRITE_TOKEN) throw new Error('WRITE_TOKEN is required for --send');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.WRITE_TOKEN,
    },
    body: JSON.stringify({
      query:
        'mutation Collect($batch: BatchInput!) { ingest(batch: $batch) { accepted assets relationships } }',
      variables: { batch },
    }),
  });
  const result = (await response.json()) as { errors?: { message: string }[] };
  if (!response.ok || result.errors) throw new Error('Ingestion failed: ' + JSON.stringify(result));
  console.error('Ingested ' + batch.scope);
}
async function main() {
  if (command === 'import') {
    await emit(
      batchSchema.parse(JSON.parse(await readFile(required(values.file, 'file'), 'utf8'))),
    );
    return;
  }
  if (command === 'kubernetes') {
    const cluster = required(values.cluster, 'cluster'),
      environment = required(values.environment, 'environment');
    const raw = values.file
      ? await readFile(values.file, 'utf8')
      : execFileSync(
          'kubectl',
          [
            '--context',
            required(values.context, 'context'),
            'get',
            'pods',
            '--all-namespaces',
            '-o',
            'json',
          ],
          { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
        );
    const data = JSON.parse(raw);
    if (!Array.isArray(data.items)) throw new Error('Expected Kubernetes PodList');
    await emit(kubernetesSnapshot(data.items, cluster, environment));
    return;
  }
  const region = required(values.region, 'region'),
    observedAt = new Date().toISOString();
  if (command === 'ecr') {
    const client = new ECRClient({ region });
    let nextToken: string | undefined;
    try {
      do {
        const page = await client.send(new DescribeRepositoriesCommand({ nextToken }));
        nextToken = page.nextToken;
        for (const repo of page.repositories ?? []) {
          const images: Batch['images'] = [];
          let cursor: string | undefined;
          do {
            const page = await client.send(
              new DescribeImagesCommand({
                repositoryName: repo.repositoryName,
                registryId: repo.registryId,
                nextToken: cursor,
              }),
            );
            cursor = page.nextToken;
            for (const item of page.imageDetails ?? [])
              if (item.imageDigest && repo.repositoryUri)
                images.push({
                  image: repo.repositoryUri,
                  digest: item.imageDigest,
                  tags: item.imageTags ?? [],
                  observedAt,
                });
          } while (cursor);
          // Images are historical inventory, not a current registry mirror. Bounded batches avoid payload limits.
          for (let i = 0; i < images.length; i += 100)
            await emit(
              batchSchema.parse({
                scope: 'ecr:' + repo.repositoryArn,
                kind: 'IMAGE',
                observedAt,
                images: images.slice(i, i + 100),
              }),
            );
        }
      } while (nextToken);
    } finally {
      client.destroy();
    }
    return;
  }
  if (command === 'ecs') {
    const environment = required(values.environment, 'environment'),
      client = new ECSClient({ region });
    let nextToken: string | undefined;
    try {
      do {
        const page = await client.send(new ListClustersCommand({ nextToken }));
        nextToken = page.nextToken;
        for (const cluster of page.clusterArns ?? []) {
          const taskArns: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.send(
              new ListTasksCommand({ cluster, desiredStatus: 'RUNNING', nextToken: cursor }),
            );
            cursor = page.nextToken;
            taskArns.push(...(page.taskArns ?? []));
          } while (cursor);
          const workloads: Workload[] = [];
          for (let i = 0; i < taskArns.length; i += 100) {
            const page = await client.send(
              new DescribeTasksCommand({ cluster, tasks: taskArns.slice(i, i + 100) }),
            );
            if (page.failures?.length)
              throw new Error(
                'ECS returned incomplete task details; refusing snapshot reconciliation',
              );
            for (const task of page.tasks ?? [])
              for (const c of task.containers ?? [])
                if (
                  task.lastStatus === 'RUNNING' &&
                  c.lastStatus === 'RUNNING' &&
                  c.image &&
                  task.taskArn &&
                  c.name
                ) {
                  const parsed = parseImage(c.image);
                  workloads.push({
                    uid: task.taskArn + '/' + c.name,
                    name: (task.group ?? task.taskArn.split('/').at(-1)) + ' / ' + c.name,
                    platform: 'ECS',
                    environment,
                    image: parsed.image,
                    digest: c.imageDigest,
                    imageReference: c.image,
                    observedAt,
                  });
                }
          }
          await emit(
            batchSchema.parse({
              scope: 'ecs:' + cluster,
              kind: 'WORKLOAD',
              complete: true,
              observedAt,
              workloads,
            }),
          );
        }
      } while (nextToken);
    } finally {
      client.destroy();
    }
    return;
  }
  throw new Error('Unknown collector: ' + command);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
