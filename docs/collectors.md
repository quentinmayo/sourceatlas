# Collector setup

Collectors output a batch as JSON unless `--send` is supplied. Sending requires `SOURCEATLAS_URL` (including `/graphql`) and `WRITE_TOKEN`. The CLI loads `.env`; credentials never enter frontend code. It rejects redirects and non-HTTPS remote ingestion endpoints. Local HTTP is allowed for development.

## CI build provenance

Use `examples/build.json` as the schema. A build needs an HTTP(S) repository URL, full 40- or 64-character commit hash, Dockerfile path, registry-qualified image repository, and SHA-256 digest. Optional owner and build URL provide context. Use a timestamp from the observation, not an arbitrary deployment timestamp.

After your existing Docker build/push step, export:

```sh
export SOURCE_REPOSITORY="https://github.com/your-org/your-service"
export SOURCE_REVISION="$GITHUB_SHA"
export DOCKERFILE_PATH="Dockerfile"
export IMAGE_REPOSITORY="123456789012.dkr.ecr.us-east-1.amazonaws.com/service"
# Set IMAGE_DIGEST to the actual digest returned by your build/push step.
export SERVICE_OWNER="platform"
export SOURCEATLAS_URL="https://inventory.example.com/graphql"
# Supply WRITE_TOKEN through your CI secret manager.
node examples/publish-build.mjs
```

The helper does not build or push images itself. It publishes the evidence you supply and rejects unresolved digest values. Build URLs are optional metadata; do not include credentials in metadata. Remote source repositories are not crawled or cloned by the server.

For multi-platform builds, the build step may return an OCI index digest while runtime reports a child manifest digest. Submit a manifest for each child digest built from that source. Never substitute the index digest for runtime evidence. Automated OCI graph expansion is future work.

## ECR and ECS

The AWS SDK uses its default credential provider chain (environment, configured profile/SSO, workload role, instance metadata). Use a separate role per account as appropriate. No credentials are embedded in the inventory. `--region` is required, and each invocation covers one AWS account/region.

Minimal discovery actions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:DescribeRepositories", "ecr:DescribeImages"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:ListClusters", "ecs:ListTasks", "ecs:DescribeTasks"],
      "Resource": "*"
    }
  ]
}
```

These are discovery-only actions. Narrow resource ARNs where your IAM setup supports it; list operations can require `*`. You do not need pull credentials, image uploads, container execution, or workload modification permissions.

ECR collection paginates repositories and images and records historical image observations. ECS paginates clusters/tasks, describes tasks in groups of 100, and records running container image digests. Any reported task-description failure aborts that cluster snapshot; it does not reconcile an incomplete result. Successful earlier clusters may already have been submitted. Rerunning is idempotent.

ECS snapshots use cluster ARN as scope. Supply the correct `--environment` for each account/region invocation. Environments derived from per-cluster tags and automatic cleanup for deleted clusters are not yet supported. Clusters over the batch/body cap require future chunking support; they fail rather than silently sending a partial snapshot.

## Kubernetes

Install `kubectl` and use an explicit context:

```sh
npm run collect -- kubernetes --context production-us \
  --cluster arn:aws:eks:us-east-1:123456789012:cluster/production-us \
  --environment production --send
```

`--cluster` must uniquely and consistently identify the cluster across all collectors. Prefer a cluster ARN or another globally unique ID, not a shared label such as `prod` for unrelated clusters. The complete snapshot covers all namespaces, so use one collector per cluster/scope. Avoid concurrent collectors with different visibility using the same scope.

Required Kubernetes RBAC (bind this role to the collector identity yourself):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sourceatlas-inventory
rules:
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['list']
```

The collector reads regular running containers from Pod status. Add `sourceatlas.io/owner` to Pod labels if you want runtime ownership. It does not read Secrets, execute commands in Pods, or modify cluster resources. Context execution is delegated to your installed kubectl and configured authentication plugins.

For offline collection:

```sh
kubectl --context production-us get pods --all-namespaces -o json > pods.json
npm run collect -- kubernetes --file pods.json --cluster production-us --environment production
```

A file is assumed to contain a complete, current PodList and is timestamped when imported. Use offline import only for trusted, complete exports. A partial/stale export can incorrectly retire or refresh workloads. No Kubernetes API calls occur in file mode.

## Reconciliation and scheduling

Run collectors on your existing scheduler at your chosen interval. They are finite CLI jobs, not daemons. Only successful complete workload snapshots retire missing workloads within their scope. Missing digests produce unresolved assets; they are never guessed from tags. SourceAtlas exposes stale observations after 24 hours but does not expire them automatically.

A zero-workload complete snapshot intentionally clears a scope. Keep an empty manifest for a retired scope if you need to retire a deleted cluster's inventory. Current retention of source and image records is indefinite.
