// Invoke after your CI build/push step. Supply secrets through your CI secret manager.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const endpoint = new URL(required('SOURCEATLAS_URL'));
if (
  endpoint.protocol !== 'https:' &&
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
)
  throw new Error('Remote ingestion requires HTTPS');
const digest = required('IMAGE_DIGEST');
if (!/^sha256:[a-f0-9]{64}$/.test(digest))
  throw new Error('IMAGE_DIGEST must be the actual immutable build digest');
const observedAt = new Date().toISOString(),
  repository = required('SOURCE_REPOSITORY');
const batch = {
  scope: 'ci:' + repository,
  kind: 'BUILD',
  observedAt,
  builds: [
    {
      repository,
      revision: required('SOURCE_REVISION'),
      dockerfile: process.env.DOCKERFILE_PATH ?? 'Dockerfile',
      image: required('IMAGE_REPOSITORY'),
      digest,
      observedAt,
      ...(process.env.SERVICE_OWNER ? { owner: process.env.SERVICE_OWNER } : {}),
      ...(process.env.BUILD_URL ? { buildUrl: process.env.BUILD_URL } : {}),
    },
  ],
};
const response = await fetch(endpoint, {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + required('WRITE_TOKEN'),
  },
  body: JSON.stringify({
    query: 'mutation($batch:BatchInput!){ingest(batch:$batch){accepted}}',
    variables: { batch },
  }),
});
const result = await response.json();
if (!response.ok || result.errors)
  throw new Error('Provenance ingestion failed: ' + JSON.stringify(result));
console.log('Recorded build provenance for ' + digest);
