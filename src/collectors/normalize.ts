import { batchSchema, type Batch, type Workload } from '../server/model.js';
export function parseImage(reference: string): { image: string; digest?: string } {
  const ref = reference.replace(/^(docker-pullable|docker|containerd):\/\//, '');
  const [named, pinned] = ref.split('@');
  let image = named.replace(/:[^/:]+$/, '');
  const first = image.split('/')[0];
  if (!image.includes('/')) image = 'docker.io/library/' + image;
  else if (!first.includes('.') && !first.includes(':') && first !== 'localhost')
    image = 'docker.io/' + image;
  return { image, digest: pinned?.match(/^sha256:[a-f0-9]{64}$/)?.[0] };
}
export function runtimeDigest(imageId?: string): string | undefined {
  return imageId?.match(/(?:^|@|\/\/)(sha256:[a-f0-9]{64})$/)?.[1];
}
export type Pod = {
  metadata: { uid: string; name: string; namespace?: string; labels?: Record<string, string> };
  spec?: { containers?: { name: string; image: string }[] };
  status?: {
    phase?: string;
    containerStatuses?: { name: string; imageID?: string; state?: { running?: unknown } }[];
  };
};
export function kubernetesSnapshot(
  items: Pod[],
  cluster: string,
  environment: string,
  observedAt = new Date().toISOString(),
): Batch {
  const workloads: Workload[] = [];
  for (const pod of items) {
    if (pod.status?.phase !== 'Running') continue;
    for (const container of pod.spec?.containers ?? []) {
      const status = pod.status?.containerStatuses?.find((s) => s.name === container.name);
      if (!status?.state?.running) continue;
      const parsed = parseImage(container.image);
      // A spec digest is desired state; only status.imageID is runtime evidence.
      workloads.push({
        uid: pod.metadata.uid + '/' + container.name,
        name: pod.metadata.name + ' / ' + container.name,
        platform: 'KUBERNETES',
        environment,
        namespace: pod.metadata.namespace,
        owner: pod.metadata.labels?.['sourceatlas.io/owner'],
        image: parsed.image,
        digest: runtimeDigest(status.imageID),
        imageReference: container.image,
        observedAt,
      });
    }
  }
  return batchSchema.parse({
    scope: 'kubernetes:' + cluster,
    kind: 'WORKLOAD',
    complete: true,
    observedAt,
    workloads,
  });
}
