import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Boxes,
  GitBranch,
  Search,
  ArrowUpRight,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  Network,
  Database,
  Box,
  Code2,
  Layers,
  Server,
  ArrowRight,
  Plug,
  X,
  KeyRound,
  ExternalLink,
} from 'lucide-react';
import type { Asset, Graph } from '../server/model';
import './style.css';
const fields =
  'id type name observedAt owner repository revision dockerfile image digest environment platform namespace imageReference tags';
type Summary = {
  repositories: number;
  images: number;
  workloads: number;
  environments: number;
  coverage: number;
  findings: number;
  mode: string;
};
type Finding = { id: string; severity: string; title: string; detail: string; asset: Asset };
const icons: Record<string, React.ElementType> = {
  REPOSITORY: GitBranch,
  DOCKERFILE: Code2,
  IMAGE: Box,
  REGISTRY: Database,
  WORKLOAD: Server,
  ENVIRONMENT: Layers,
};
const labels: Record<string, string> = {
  REPOSITORY: 'Repository',
  DOCKERFILE: 'Dockerfile',
  IMAGE: 'Container image',
  REGISTRY: 'Registry',
  WORKLOAD: 'Workload',
  ENVIRONMENT: 'Environment',
};
function KindIcon({ type, size = 18 }: { type: string; size?: number }) {
  const Icon = icons[type] ?? Box;
  return <Icon size={size} />;
}
function App() {
  const [token, setToken] = useState(''),
    [inputToken, setInputToken] = useState(''),
    [authOpen, setAuthOpen] = useState(false);
  const [summary, setSummary] = useState<Summary>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [issues, setIssues] = useState<Finding[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Asset>(),
    [graph, setGraph] = useState<Graph>(),
    [view, setView] = useState('inventory'),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('');
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [updated, setUpdated] = useState('');
  async function api(query: string, variables: Record<string, unknown> = {}) {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (body.errors) throw new Error(body.errors[0].message);
    if (!response.ok) throw new Error('Inventory request failed');
    return body.data;
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api(
      `query Inventory($search:String,$type:AssetType,$offset:Int){summary{repositories images workloads environments coverage findings mode} assets(search:$search,type:$type,offset:$offset,limit:12){total items{${fields}}} findings{id severity title detail asset{${fields}}}}`,
      { search: query, type: kind || null, offset },
    )
      .then((data) => {
        if (!active) return;
        setSummary(data.summary);
        setAssets(data.assets.items);
        setTotal(data.assets.total);
        setIssues(data.findings);
        setUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        setSelected(
          (previous) =>
            previous ??
            data.assets.items.find((a: Asset) => a.type === 'REPOSITORY') ??
            data.assets.items[0],
        );
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, query, kind, offset, refresh]);
  useEffect(() => {
    let active = true;
    setGraph(undefined);
    if (selected)
      api(
        `query Trace($id:ID!){lineage(id:$id){assets{${fields}} links{id source target type evidence observedAt}}}`,
        { id: selected.id },
      )
        .then((d) => {
          if (active) setGraph(d.lineage);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, token, refresh]);
  const trace = (asset: Asset) => {
    setSelected(asset);
    setView('lineage');
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="SourceAtlas home">
          <span className="mark">A</span>SourceAtlas<span className="beta">α</span>
        </a>
        <div className="workspace">
          <div className="workspace-icon">
            <Boxes size={19} />
          </div>
          <div>
            Engineering workspace<small>Code to cloud inventory</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            ['inventory', 'Asset inventory', Boxes],
            ['lineage', 'Deployment lineage', Network],
            ['findings', 'Coverage gaps', ShieldAlert],
            ['sources', 'Data sources', Plug],
          ].map(([id, label, Icon]) => {
            const I = Icon as React.ElementType;
            return (
              <button
                key={String(id)}
                className={view === id ? 'nav-item active' : 'nav-item'}
                onClick={() => setView(String(id))}
              >
                <I size={18} />
                {String(label)}
                {id === 'findings' && !!issues.length && (
                  <span className="count">{issues.length}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="open-source">
            <GitBranch size={18} />
            <div>
              Built in the open<small>Apache 2.0 · v0.1.0</small>
            </div>
            <a
              href="https://github.com/quentinmayo/sourceatlas"
              target="_blank"
              rel="noreferrer"
              aria-label="Open GitHub repository"
            >
              <ArrowUpRight size={17} />
            </a>
          </div>
          <button className="profile" onClick={() => setAuthOpen(true)}>
            <span className="avatar">
              <KeyRound size={16} />
            </span>
            <div>
              Workspace access
              <small>{token ? 'Reader token connected' : 'Manage API connection'}</small>
            </div>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={14} />{' '}
            <strong>
              {
                (
                  {
                    inventory: 'Asset inventory',
                    lineage: 'Deployment lineage',
                    findings: 'Coverage gaps',
                    sources: 'Data sources',
                  } as Record<string, string>
                )[view]
              }
            </strong>
          </div>
          <div>
            <span className={'mode ' + (summary?.mode === 'demo' ? 'demo' : '')}>
              {summary
                ? summary.mode === 'demo'
                  ? 'Sample workspace'
                  : 'Connected inventory'
                : 'Connecting'}
            </span>
            <a
              href="https://github.com/quentinmayo/sourceatlas#readme"
              target="_blank"
              rel="noreferrer"
            >
              Docs <ArrowUpRight size={14} />
            </a>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR SOFTWARE, IN CONTEXT</div>
              <h1>
                {view === 'inventory'
                  ? 'Asset inventory'
                  : view === 'lineage'
                    ? 'From source to runtime'
                    : view === 'findings'
                      ? 'Close the visibility gaps'
                      : 'Connect your inventory'}
              </h1>
              <p>
                {view === 'inventory'
                  ? 'Know what you own. See where it runs.'
                  : view === 'lineage'
                    ? 'Follow the evidence from a commit to a running workload.'
                    : view === 'findings'
                      ? 'Find running workloads with unknown source code or ownership.'
                      : 'Bring build evidence and runtime observations into one graph.'}
              </p>
            </div>
            <button className="button" onClick={() => setRefresh((r) => r + 1)} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh inventory
            </button>
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
              <button className="button" onClick={() => setAuthOpen(true)}>
                Connect reader token
              </button>
            </div>
          )}
          {summary?.mode === 'demo' && (
            <div className="demo-banner">
              <span className="status-dot" />
              You’re exploring sample data. Connect your own collectors to map your infrastructure.
              <button onClick={() => setView('sources')}>
                View setup <ArrowRight size={14} />
              </button>
            </div>
          )}
          {summary && (
            <div className="stats">
              {[
                [GitBranch, summary.repositories, 'Repositories', 'Source of truth'],
                [Box, summary.images, 'Container images', 'Identified by digest'],
                [
                  Server,
                  summary.workloads,
                  'Running containers',
                  `${summary.environments} environments`,
                ],
                [
                  Network,
                  Math.round(summary.coverage) + '%',
                  'Source coverage',
                  'Runtime linked to source',
                ],
              ].map(([Icon, value, title, note]) => {
                const I = Icon as React.ElementType;
                return (
                  <div className="stat" key={String(title)}>
                    <div className="stat-title">
                      {String(title)}
                      <I size={17} />
                    </div>
                    <div className="stat-value">{String(value)}</div>
                    <small>{String(note)}</small>
                    {title === 'Source coverage' && (
                      <div className="progress">
                        <div style={{ width: summary.coverage + '%' }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {view === 'inventory' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    Explore your assets <span>{total}</span>
                  </h2>
                  <p>Search repositories, images, owners, and environments.</p>
                </div>
                <small className="muted">{updated && 'Refreshed ' + updated}</small>
              </div>
              <div className="inventory panel">
                <div className="toolbar">
                  <label className="search">
                    <Search size={18} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search inventory…"
                      aria-label="Search inventory"
                    />
                    <kbd>⌕</kbd>
                  </label>
                  <select
                    aria-label="Asset type"
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All asset types</option>
                    {Object.entries(labels).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Type</th>
                        <th>Owner</th>
                        <th>Context</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {assets.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <button className="asset-button" onClick={() => trace(a)}>
                              <span className={'asset-icon ' + a.type.toLowerCase()}>
                                <KindIcon type={a.type} />
                              </span>
                              <span>
                                {a.name}
                                <small>
                                  {a.digest
                                    ? a.digest.slice(0, 24) + '…'
                                    : a.revision
                                      ? 'Commit ' + a.revision.slice(0, 8)
                                      : (a.repository?.replace('https://', '') ??
                                        a.platform ??
                                        labels[a.type])}
                                </small>
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="type-pill">{labels[a.type]}</span>
                          </td>
                          <td>
                            {a.owner ? (
                              <span className="owner">
                                <span>{a.owner.slice(0, 1).toUpperCase()}</span>
                                {a.owner}
                              </span>
                            ) : (
                              <span className="muted">Unassigned</span>
                            )}
                          </td>
                          <td>
                            {a.environment ? (
                              <span
                                className={
                                  'env ' +
                                  (a.environment.startsWith('production') ? 'production' : '')
                                }
                              >
                                {a.environment}
                              </span>
                            ) : (
                              <span className="muted">
                                {a.type === 'IMAGE'
                                  ? 'Immutable artifact'
                                  : a.type === 'DOCKERFILE'
                                    ? 'Versioned source'
                                    : '—'}
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={'Trace ' + a.name}
                              onClick={() => trace(a)}
                            >
                              <ArrowUpRight size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!assets.length && !loading && (
                  <div className="empty">
                    <Search />
                    <h3>No assets found</h3>
                    <p>
                      {query || kind
                        ? 'Try another search or asset type.'
                        : 'Ingest a build and a runtime snapshot to begin.'}
                    </p>
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    {total ? offset + 1 : 0}–{Math.min(offset + 12, total)} of {total} assets
                  </span>
                  <div>
                    <button
                      disabled={offset === 0 || loading}
                      onClick={() => setOffset(Math.max(0, offset - 12))}
                    >
                      Previous
                    </button>
                    <button
                      disabled={offset + 12 >= total || loading}
                      onClick={() => setOffset(offset + 12)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
              <div className="insight">
                <div className="insight-icon">
                  <Network size={23} />
                </div>
                <div>
                  <h3>Every deployment has a story.</h3>
                  <p>
                    Open an asset to trace its repository, Dockerfile, image digest, and runtime.
                  </p>
                </div>
                <button className="text-button" onClick={() => setView('lineage')}>
                  Explore lineage <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}
          {view === 'lineage' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Deployment lineage</h2>
                  <p>{selected?.name ?? 'Select an asset in the inventory to begin.'}</p>
                </div>
                <button className="text-button" onClick={() => setView('inventory')}>
                  Choose another asset <ArrowRight size={16} />
                </button>
              </div>
              <div className="panel graph-panel">
                {graph ? (
                  <Lineage graph={graph} selected={selected} onSelect={setSelected} />
                ) : (
                  <div className="empty">
                    {selected ? 'Loading lineage…' : 'Your lineage graph will appear here.'}
                  </div>
                )}
                <div className="graph-legend">
                  <span>
                    <i />
                    Observed relationship
                  </span>
                  <span>Matching registry + immutable digest</span>
                </div>
              </div>
              {selected && (
                <div className="details panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        <KindIcon type={selected.type} /> {selected.name}
                      </h2>
                      <p>
                        {labels[selected.type]} · Last observed{' '}
                        {new Date(selected.observedAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="type-pill">{selected.platform ?? 'Asset detail'}</span>
                  </div>
                  <dl>
                    {[
                      ['Repository', selected.repository],
                      ['Commit', selected.revision],
                      ['Dockerfile', selected.dockerfile],
                      ['Image', selected.image],
                      ['Digest', selected.digest],
                      ['Owner', selected.owner],
                      ['Environment', selected.environment],
                      ['Namespace', selected.namespace],
                    ]
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                  </dl>
                  {selected.type === 'WORKLOAD' &&
                    !graph?.assets.some((a) => a.type === 'DOCKERFILE') && (
                      <div className="warning">
                        <ShieldAlert size={18} />
                        Source attribution is unknown. Ingest build provenance for this runtime
                        digest.
                      </div>
                    )}
                  {graph && graph.links.length > 0 && (
                    <details>
                      <summary>Relationship evidence ({graph.links.length})</summary>
                      <ul className="evidence">
                        {graph.links.map((l) => (
                          <li key={l.id}>
                            <strong>{l.type.replaceAll('_', ' ')}</strong> {l.evidence}
                            <small>{new Date(l.observedAt).toLocaleString()}</small>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
          {view === 'findings' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    Inventory coverage gaps <span>{issues.length}</span>
                  </h2>
                  <p>These are visibility findings, not vulnerability scan results.</p>
                </div>
              </div>
              <div className="findings-list">
                {issues.map((f) => (
                  <button className="finding panel" key={f.id} onClick={() => trace(f.asset)}>
                    <span className={'severity ' + f.severity.toLowerCase()}>{f.severity}</span>
                    <div>
                      <h3>{f.title}</h3>
                      <p>{f.detail}</p>
                      <small>
                        {f.asset.name} · {f.asset.environment}
                      </small>
                    </div>
                    <ArrowUpRight size={18} />
                  </button>
                ))}
                {!issues.length && (
                  <div className="panel empty">
                    <ShieldAlert />
                    <h3>No visibility gaps detected</h3>
                    <p>
                      {summary?.workloads
                        ? 'All observed workloads have source attribution and an owner.'
                        : 'Connect runtime collectors to evaluate coverage.'}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
          {view === 'sources' && (
            <div className="sources">
              <div className="panel setup">
                <div className="source-symbol">
                  <Code2 />
                </div>
                <h2>01 / Build provenance</h2>
                <p>
                  Record the repository, commit, Dockerfile, and image digest after a successful CI
                  build.
                </p>
                <code>npm run collect -- import --file build.json --send</code>
                <a
                  href="https://github.com/quentinmayo/sourceatlas/blob/main/examples/build.json"
                  target="_blank"
                  rel="noreferrer"
                >
                  View build manifest <ExternalLink size={14} />
                </a>
              </div>
              <div className="panel setup">
                <div className="source-symbol">
                  <Database />
                </div>
                <h2>02 / Amazon ECR</h2>
                <p>
                  Discover image digests and tags with the AWS credential chain. Access is
                  read-only.
                </p>
                <code>npm run collect -- ecr --region us-east-1 --send</code>
                <small>Required: ecr:DescribeRepositories, ecr:DescribeImages</small>
              </div>
              <div className="panel setup">
                <div className="source-symbol">
                  <Layers />
                </div>
                <h2>03 / Kubernetes</h2>
                <p>
                  Observe running containers using an explicit kubectl context and a stable cluster
                  identity.
                </p>
                <code>
                  npm run collect -- kubernetes --context prod --cluster prod-us --environment
                  production --send
                </code>
                <small>Required: list pods across namespaces</small>
              </div>
              <div className="panel setup">
                <div className="source-symbol">
                  <Server />
                </div>
                <h2>04 / Amazon ECS</h2>
                <p>
                  Connect actual running tasks and container digests to source evidence, across all
                  clusters in a region.
                </p>
                <code>
                  npm run collect -- ecs --region us-east-1 --environment production --send
                </code>
                <small>Required: ecs:ListClusters, ecs:ListTasks, ecs:DescribeTasks</small>
              </div>
              <div className="panel setup wide">
                <h2>Self-host your workspace</h2>
                <p>
                  Start Neo4j and SourceAtlas with Docker Compose. Collectors send observations to
                  your authenticated GraphQL endpoint. No cloud credentials are stored in this
                  browser.
                </p>
                <code>docker compose up --build -d</code>
                <p>
                  Set SOURCEATLAS_URL and WRITE_TOKEN in the collector environment. See the
                  repository for the complete setup and permissions.
                </p>
                <a
                  href="https://github.com/quentinmayo/sourceatlas/blob/main/docs/collectors.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read collector setup <ArrowUpRight size={16} />
                </a>
              </div>
            </div>
          )}
          <footer>
            <span>
              SourceAtlas <span className="muted">/</span> Source code. Cloud assets. Connected.
            </span>
            <span>Evidence-backed inventory</span>
          </footer>
        </div>
      </main>
      {authOpen && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          className="modal panel"
          aria-labelledby="access-title"
          onClose={() => setAuthOpen(false)}
        >
          <button
            className="close icon-button"
            aria-label="Close connection dialog"
            onClick={() => setAuthOpen(false)}
          >
            <X />
          </button>
          <KeyRound />
          <h2 id="access-title">Connect to your inventory</h2>
          <p>Enter your reader token. It stays in memory for this page session.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToken(inputToken);
              setInputToken('');
              setAuthOpen(false);
              setSelected(undefined);
            }}
          >
            <label>
              Reader token
              <input
                autoFocus
                type="password"
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <button className="button primary" type="submit">
              Connect workspace <ArrowRight size={16} />
            </button>
          </form>
        </dialog>
      )}
    </div>
  );
}
function Lineage({
  graph,
  selected,
  onSelect,
}: {
  graph: Graph;
  selected?: Asset;
  onSelect: (a: Asset) => void;
}) {
  const types = ['REPOSITORY', 'DOCKERFILE', 'IMAGE', 'WORKLOAD', 'ENVIRONMENT'];
  const visible = graph.assets.filter((a) => types.includes(a.type));
  const max = Math.max(1, ...types.map((t) => visible.filter((a) => a.type === t).length));
  const width = 1080,
    height = 100 + max * 112;
  const positions = new Map<string, { x: number; y: number }>();
  types.forEach((type, i) =>
    visible
      .filter((a) => a.type === type)
      .forEach((a, j) => positions.set(a.id, { x: 24 + i * 212, y: 65 + j * 112 })),
  );
  return (
    <div className="graph-scroll">
      <div className="graph-canvas" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#81a696" />
            </marker>
          </defs>
          {graph.links.map((l) => {
            const a = positions.get(l.source),
              b = positions.get(l.target);
            if (!a || !b) return null;
            return (
              <path
                key={l.id}
                d={`M ${a.x + 178} ${a.y + 38} C ${a.x + 196} ${a.y + 38},${b.x - 18} ${b.y + 38},${b.x} ${b.y + 38}`}
                fill="none"
                stroke="#81a696"
                strokeWidth="1.6"
                markerEnd="url(#arrow)"
              />
            );
          })}
        </svg>
        {types.map((type, i) => (
          <div className="column-label" key={type} style={{ left: 24 + i * 212 }}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            {labels[type]}
          </div>
        ))}
        {visible.map((a) => {
          const pos = positions.get(a.id)!;
          return (
            <button
              key={a.id}
              className={'graph-node ' + (selected?.id === a.id ? 'selected' : '')}
              style={{ left: pos.x, top: pos.y }}
              onClick={() => onSelect(a)}
              title={a.name}
            >
              <span className="node-type">
                <KindIcon type={a.type} size={15} />
                {a.platform ?? labels[a.type]}
              </span>
              <strong>{a.name}</strong>
              <small>
                {a.digest
                  ? a.digest.slice(0, 19) + '…'
                  : a.revision
                    ? a.revision.slice(0, 8)
                    : (a.owner ?? a.environment ?? 'Source asset')}
              </small>
            </button>
          );
        })}
        {types
          .filter((t) => !visible.some((a) => a.type === t))
          .map((t) => (
            <div
              className="graph-missing"
              key={t}
              style={{ left: 24 + types.indexOf(t) * 212, top: 65 }}
            >
              No linked {labels[t].toLowerCase()}
            </div>
          ))}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
