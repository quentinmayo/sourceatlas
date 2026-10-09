import { timingSafeEqual } from 'node:crypto';
import { createSchema, createYoga } from 'graphql-yoga';
import { GraphQLError, type ValidationRule } from 'graphql';
import { batchSchema, type Graph } from './model.js';
import { findings, lineage } from './graph.js';
import type { Store } from './store.js';
const typeDefs = /* GraphQL */ `
  enum AssetType {
    REPOSITORY
    DOCKERFILE
    IMAGE
    REGISTRY
    WORKLOAD
    ENVIRONMENT
  }
  type Asset {
    id: ID!
    type: AssetType!
    name: String!
    observedAt: String!
    owner: String
    repository: String
    revision: String
    dockerfile: String
    image: String
    digest: String
    environment: String
    platform: String
    namespace: String
    imageReference: String
    tags: [String!]
  }
  type Relationship {
    id: ID!
    source: ID!
    target: ID!
    type: String!
    evidence: String!
    observedAt: String!
  }
  type Graph {
    assets: [Asset!]!
    links: [Relationship!]!
  }
  type AssetPage {
    items: [Asset!]!
    total: Int!
    offset: Int!
    hasMore: Boolean!
  }
  type Finding {
    id: ID!
    severity: String!
    title: String!
    detail: String!
    asset: Asset!
  }
  type Summary {
    repositories: Int!
    images: Int!
    workloads: Int!
    environments: Int!
    coverage: Float!
    findings: Int!
    mode: String!
  }
  type IngestResult {
    accepted: Boolean!
    assets: Int!
    relationships: Int!
  }
  input BuildInput {
    repository: String!
    revision: String!
    dockerfile: String!
    image: String!
    digest: String!
    owner: String
    buildUrl: String
    observedAt: String!
  }
  input ImageInput {
    image: String!
    digest: String!
    tags: [String!]
    observedAt: String!
  }
  input WorkloadInput {
    uid: String!
    name: String!
    platform: String!
    environment: String!
    image: String!
    digest: String
    imageReference: String!
    namespace: String
    owner: String
    observedAt: String!
  }
  input BatchInput {
    scope: String!
    kind: String!
    observedAt: String!
    builds: [BuildInput!]
    images: [ImageInput!]
    workloads: [WorkloadInput!]
    complete: Boolean
  }
  type Query {
    summary: Summary!
    assets(
      search: String
      type: AssetType
      environment: String
      offset: Int = 0
      limit: Int = 100
    ): AssetPage!
    asset(id: ID!): Asset
    lineage(id: ID!): Graph!
    findings: [Finding!]!
  }
  type Mutation {
    ingest(batch: BatchInput!): IngestResult!
  }
`;
function equals(value: string, expected: string) {
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const boundedQuery: ValidationRule = (context) => {
  let depth = 0,
    count = 0;
  return {
    SelectionSet: {
      enter() {
        if (++depth > 10) context.reportError(new GraphQLError('Query nesting exceeds 10'));
      },
      leave() {
        depth--;
      },
    },
    Field() {
      if (++count > 300) context.reportError(new GraphQLError('Query exceeds 300 fields'));
    },
    FragmentSpread() {
      context.reportError(
        new GraphQLError('Named fragments are disabled in this MVP; use inline fragments'),
      );
    },
  };
};
type Context = { request: Request; graph: () => Promise<Graph> };
export function createApi(
  store: Store,
  config: { demo: boolean; readToken?: string; writeToken?: string },
) {
  const schema = createSchema<Context>({
    typeDefs,
    resolvers: {
      Query: {
        summary: async (_: unknown, __: unknown, ctx: Context) => {
          const g = await ctx.graph(),
            workloads = g.assets.filter((a) => a.type === 'WORKLOAD');
          return {
            repositories: g.assets.filter((a) => a.type === 'REPOSITORY').length,
            images: g.assets.filter((a) => a.type === 'IMAGE').length,
            workloads: workloads.length,
            environments: g.assets.filter((a) => a.type === 'ENVIRONMENT').length,
            coverage: workloads.length
              ? (100 *
                  workloads.filter((a) =>
                    lineage(g, a.id).assets.some((n) => n.type === 'DOCKERFILE'),
                  ).length) /
                workloads.length
              : 0,
            findings: findings(g).length,
            mode: config.demo ? 'demo' : 'live',
          };
        },
        assets: async (
          _: unknown,
          args: {
            search?: string;
            type?: string;
            environment?: string;
            offset: number;
            limit: number;
          },
          ctx: Context,
        ) => {
          if (args.offset < 0 || args.limit < 1 || args.limit > 500)
            throw new GraphQLError('Use offset >= 0 and limit between 1 and 500');
          const g = await ctx.graph(),
            query = args.search?.toLowerCase() ?? '';
          const items = g.assets
            .filter(
              (a) =>
                (!args.type || a.type === args.type) &&
                (!args.environment || a.environment === args.environment) &&
                Object.values(a).some((v) => String(v).toLowerCase().includes(query)),
            )
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
          return {
            items: items.slice(args.offset, args.offset + args.limit),
            total: items.length,
            offset: args.offset,
            hasMore: args.offset + args.limit < items.length,
          };
        },
        asset: async (_: unknown, { id }: { id: string }, ctx: Context) =>
          (await ctx.graph()).assets.find((a) => a.id === id),
        lineage: async (_: unknown, { id }: { id: string }, ctx: Context) =>
          lineage(await ctx.graph(), id),
        findings: async (_: unknown, __: unknown, ctx: Context) => findings(await ctx.graph()),
      },
      Mutation: {
        ingest: async (_: unknown, { batch }: { batch: unknown }, ctx: Context) => {
          const token = ctx.request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
          if (!config.writeToken || !equals(token, config.writeToken))
            throw new GraphQLError('Collector token required', {
              extensions: { code: 'FORBIDDEN' },
            });
          const parsed = batchSchema.safeParse(batch);
          if (!parsed.success)
            throw new GraphQLError(
              parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
              { extensions: { code: 'BAD_USER_INPUT' } },
            );
          await store.ingest(parsed.data);
          const g = await store.read();
          return { accepted: true, assets: g.assets.length, relationships: g.links.length };
        },
      },
    },
  });
  return createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: config.demo,
    cors: false,
    maskedErrors: true,
    plugins: [
      {
        onValidate({ addValidationRule }: { addValidationRule: (rule: ValidationRule) => void }) {
          addValidationRule(boundedQuery);
        },
      },
    ],
    context: ({ request }) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        !config.demo &&
        !(
          (config.readToken && equals(token, config.readToken)) ||
          (config.writeToken && equals(token, config.writeToken))
        )
      )
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      let snapshot: Promise<Graph> | undefined;
      return { request, graph: () => (snapshot ??= store.read()) };
    },
  });
}
