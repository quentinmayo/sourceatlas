import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'Expected immutable sha256 digest');
const registry = text.refine(
  (v) => !v.includes('@') && !/\s/.test(v) && !v.split('/').at(-1)!.includes(':'),
  'Use registry/repository without tag or digest',
);
const timestamp = z.iso
  .datetime()
  .transform((v) => new Date(v).toISOString())
  .refine((v) => Date.parse(v) <= Date.now() + 300_000, 'Observation cannot be in the future');
export const buildSchema = z.object({
  repository: z
    .url()
    .refine(
      (v) => /^https?:\/\//.test(v) && !new URL(v).username && !new URL(v).password,
      'Use an HTTP(S) repository URL without credentials',
    ),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  dockerfile: text,
  image: registry,
  digest,
  owner: text.optional(),
  buildUrl: z.url().optional(),
  observedAt: timestamp,
});
export const imageSchema = z.object({
  image: registry,
  digest,
  tags: z.array(text).max(100).default([]),
  observedAt: timestamp,
});
export const workloadSchema = z.object({
  uid: text,
  name: text,
  platform: z.enum(['KUBERNETES', 'ECS']),
  environment: text,
  image: registry,
  digest: digest.optional(),
  imageReference: text,
  namespace: text.optional(),
  owner: text.optional(),
  observedAt: timestamp,
});
export const batchSchema = z
  .object({
    scope: text,
    kind: z.enum(['BUILD', 'IMAGE', 'WORKLOAD']),
    observedAt: timestamp,
    builds: z.array(buildSchema).max(1000).default([]),
    images: z.array(imageSchema).max(5000).default([]),
    workloads: z.array(workloadSchema).max(5000).default([]),
    complete: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    if (new Set(b.workloads.map((w) => w.uid)).size !== b.workloads.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate workload UID in snapshot' });
    if (b.workloads.some((w) => w.observedAt !== b.observedAt))
      ctx.addIssue({
        code: 'custom',
        message: 'Workload timestamps must equal snapshot timestamp',
      });
    if (
      (b.kind !== 'BUILD' && b.builds.length) ||
      (b.kind !== 'IMAGE' && b.images.length) ||
      (b.kind !== 'WORKLOAD' && b.workloads.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Batch must contain only its declared kind' });
  });
export type Batch = z.infer<typeof batchSchema>;
export type Build = z.infer<typeof buildSchema>;
export type Workload = z.infer<typeof workloadSchema>;
export type AssetType =
  'REPOSITORY' | 'DOCKERFILE' | 'IMAGE' | 'REGISTRY' | 'WORKLOAD' | 'ENVIRONMENT';
export type Asset = {
  id: string;
  type: AssetType;
  name: string;
  observedAt: string;
  scope?: string;
  owner?: string;
  repository?: string;
  revision?: string;
  dockerfile?: string;
  image?: string;
  digest?: string;
  environment?: string;
  platform?: string;
  namespace?: string;
  imageReference?: string;
  tags?: string[];
};
export type Link = {
  id: string;
  source: string;
  target: string;
  type: string;
  evidence: string;
  observedAt: string;
};
export type Graph = { assets: Asset[]; links: Link[] };
export const key = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const imageId = (image: string, digest: string) => key('IMAGE', image, digest);
export const repoUrl = (url: string) => url.replace(/\/$/, '').replace(/\.git$/, '');
export function normalize(batch: Batch): Graph {
  const assets = new Map<string, Asset>(),
    links = new Map<string, Link>();
  const add = (asset: Asset) => {
    assets.set(asset.id, asset);
    return asset.id;
  };
  const connect = (
    source: string,
    target: string,
    type: string,
    evidence: string,
    observedAt: string,
  ) => {
    const id = key(source, target, type);
    links.set(id, { id, source, target, type, evidence, observedAt });
  };
  function imageAsset(image: string, digest: string, observedAt: string, tags?: string[]) {
    const id = add({
      id: imageId(image, digest),
      type: 'IMAGE',
      name: image.split('/').at(-1)!,
      image,
      digest,
      observedAt,
      ...(tags ? { tags } : {}),
    });
    const registry = image.split('/')[0];
    const rid = add({
      id: key('REGISTRY', registry),
      type: 'REGISTRY',
      name: registry,
      observedAt,
    });
    connect(id, rid, 'STORED_IN', 'Registry-qualified image digest', observedAt);
    return id;
  }
  for (const b of batch.builds) {
    const repository = repoUrl(b.repository),
      observedAt = b.observedAt;
    const rid = add({
      id: key('REPOSITORY', repository),
      type: 'REPOSITORY',
      name: repository.split('/').slice(-2).join('/'),
      repository,
      owner: b.owner,
      observedAt,
    });
    const did = add({
      id: key('DOCKERFILE', repository, b.revision, b.dockerfile),
      type: 'DOCKERFILE',
      name: b.dockerfile,
      repository,
      revision: b.revision,
      dockerfile: b.dockerfile,
      owner: b.owner,
      observedAt,
    });
    const iid = imageAsset(b.image, b.digest, observedAt);
    connect(rid, did, 'CONTAINS', 'Repository path at commit ' + b.revision, observedAt);
    connect(
      did,
      iid,
      'BUILT_AS',
      b.buildUrl ? 'CI build: ' + b.buildUrl : 'Submitted build provenance',
      observedAt,
    );
  }
  for (const i of batch.images) imageAsset(i.image, i.digest, i.observedAt, i.tags);
  for (const w of batch.workloads) {
    const observedAt = w.observedAt;
    const wid = add({
      id: key('WORKLOAD', batch.scope, w.uid),
      type: 'WORKLOAD',
      scope: batch.scope,
      ...w,
    });
    const eid = add({
      id: key('ENVIRONMENT', w.platform, w.environment),
      type: 'ENVIRONMENT',
      name: w.environment,
      environment: w.environment,
      platform: w.platform,
      observedAt,
    });
    connect(wid, eid, 'RUNS_IN', 'Runtime collector observation', observedAt);
    if (w.digest)
      connect(
        imageAsset(w.image, w.digest, observedAt),
        wid,
        'DEPLOYED_AS',
        'Runtime-reported immutable image digest',
        observedAt,
      );
  }
  return { assets: [...assets.values()], links: [...links.values()] };
}
