#!/usr/bin/env python3
"""Mini file-level import-only clustering, built on top of graphify's graph.json.

Unlike graphify's own clustering (which runs community detection over EVERY
edge type at once -- calls, references, implements, inherits, contains, ...),
this restricts the graph to import/module edges only, collapsed to file
granularity, and drops external (non-repo) targets before clustering. That
was the actual ask: "import based clustering", not "everything that shares a
protocol conformance clustering" (the Equatable problem -- see graphify-out's
GRAPH_REPORT.md community list for what that looked like).

Run via `just graphify-import-graph` (wires graph.json / output / repo root
for this checkout and installs networkx into an ephemeral uv env -- no
hardcoded interpreter path).
"""
import json
import os
import re
import sys
from collections import defaultdict

import networkx as nx
from networkx.algorithms.community import louvain_communities

IMPORT_RELATIONS = {"imports", "imports_from", "re_exports", "dynamic_import"}

PALETTE = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948",
    "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
]

TEST_FILE_RE = re.compile(
    r"(\.(test|spec)\.[a-z]+$)"       # foo.test.ts, foo.spec.tsx
    r"|(^test_.*\.py$)"                # test_foo.py
    r"|(_test\.py$)"                   # foo_test.py
    r"|(Tests?\.swift$)"               # FooTests.swift, FooTest.swift
    r"|(/__tests__/)"                  # __tests__/ dirs
    r"|(/Tests/)"                      # Swift package Tests/ dirs
)


def is_test_file(source_file: str) -> bool:
    return bool(TEST_FILE_RE.search(source_file))


def is_real_file(source_file: str) -> bool:
    # a couple of external packages (@xterm/xterm, mermaid) get mislabeled
    # file_type="code" upstream instead of "concept" -- a real repo file
    # always has an extension, a bare package specifier never does.
    return bool(source_file) and "." in source_file.rsplit("/", 1)[-1]


def build_file_import_graph(graph_json_path: str) -> nx.DiGraph:
    with open(graph_json_path) as f:
        g = json.load(f)

    nodes_by_id = {n["id"]: n for n in g["nodes"]}

    G = nx.DiGraph()
    for n in g["nodes"]:
        sf = n.get("source_file", "")
        if n.get("file_type") == "code" and is_real_file(sf) and not is_test_file(sf):
            G.add_node(sf)

    edge_weight = defaultdict(int)
    for link in g["links"]:
        if link.get("relation") not in IMPORT_RELATIONS:
            continue
        s = nodes_by_id.get(link["source"])
        t = nodes_by_id.get(link["target"])
        if not s or not t:
            continue
        # only repo-local code files on both ends -- drop external packages
        # (node_modules deps, stdlib) so they can't become false hubs the
        # same way Equatable did in the full graph.
        if s.get("file_type") != "code" or t.get("file_type") != "code":
            continue
        sf, tf = s.get("source_file"), t.get("source_file")
        if not sf or not tf or sf == tf:
            continue
        if not is_real_file(sf) or not is_real_file(tf):
            continue
        if is_test_file(sf) or is_test_file(tf):
            continue
        edge_weight[(sf, tf)] += 1

    for (sf, tf), w in edge_weight.items():
        G.add_edge(sf, tf, weight=w)

    return G


def cluster(G: nx.DiGraph) -> dict:
    undirected = G.to_undirected()
    isolates = [n for n in undirected.nodes() if undirected.degree(n) == 0]
    connected = undirected.subgraph(n for n in undirected.nodes() if n not in isolates)
    communities = louvain_communities(connected, weight="weight", seed=42) if connected.number_of_nodes() else []
    node_community = {}
    for cid, members in enumerate(communities):
        for m in members:
            node_community[m] = cid
    next_cid = len(communities)
    for n in isolates:
        node_community[n] = next_cid
        next_cid += 1
    return node_community


MAX_EMBED_BYTES = 300_000  # a couple of minified/generated files run past this; skip rather than bloat every load


def json_for_script(value) -> str:
    """json.dumps, safe to inline inside a <script> tag.

    Embedded file content can legitimately contain the literal substring
    "</script" (three chrome-test/*.mjs fixtures do, as Playwright snippets).
    Un-escaped, that closes the real <script> tag early and the rest of the
    page renders as plain text -- not a layout bug, a tag-injection bug.
    """
    return (
        json.dumps(value)
        .replace("</script", "<\\/script")
        .replace("<!--", "<\\!--")
    )


def render_html(G: nx.DiGraph, node_community: dict, out_path: str, repo_root: str) -> None:
    file_contents = {}
    for n in G.nodes():
        p = os.path.join(repo_root, n)
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        if size > MAX_EMBED_BYTES:
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                file_contents[n] = fh.read()
        except OSError:
            continue

    community_members = defaultdict(list)
    for n, cid in node_community.items():
        community_members[cid].append(n)

    # label each community by its shared folder prefix, not a hub node --
    # this is a file-import graph, folders already ARE the grouping signal
    def common_prefix_label(files):
        if len(files) == 1:
            return files[0]
        parts_list = [f.split("/") for f in files]
        common = []
        for parts in zip(*parts_list):
            if len(set(parts)) == 1:
                common.append(parts[0])
            else:
                break
        return "/".join(common) if common else "(mixed)"

    community_label = {cid: common_prefix_label(sorted(members)) for cid, members in community_members.items()}

    vis_nodes = []
    for n in G.nodes():
        cid = node_community[n]
        color = PALETTE[cid % len(PALETTE)]
        degree = G.to_undirected().degree(n)
        vis_nodes.append({
            "id": n,
            "label": n.split("/")[-1],
            "title": n,
            "color": {"background": color, "border": color, "highlight": {"background": "#ffffff", "border": color}},
            "size": 8 + min(degree, 30),
            "font": {"size": 11, "color": "#ffffff"},
            "_source_file": n,
            "_community": cid,
            "_community_name": community_label[cid],
            "_degree": degree,
        })

    vis_edges = [
        {"from": s, "to": t, "arrows": "to", "width": min(1 + G[s][t]["weight"] * 0.3, 4), "color": {"opacity": 0.35}}
        for s, t in G.edges()
    ]

    legend = sorted(
        ({"cid": cid, "color": PALETTE[cid % len(PALETTE)], "label": community_label[cid], "count": len(members)}
         for cid, members in community_members.items()),
        key=lambda x: -x["count"],
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>import graph - {os.path.basename(out_path)}</title>
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"
        integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1"
        crossorigin="anonymous"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }}
  #graph {{ flex: 1; }}
  #sidebar {{ width: 300px; background: #1a1a2e; border-left: 1px solid #2a2a4e; display: flex; flex-direction: column; overflow: hidden; }}
  #search-wrap {{ padding: 12px; border-bottom: 1px solid #2a2a4e; }}
  #search {{ width: 100%; background: #0f0f1a; border: 1px solid #3a3a5e; color: #e0e0e0; padding: 7px 10px; border-radius: 6px; font-size: 13px; outline: none; }}
  #search-results {{ max-height: 140px; overflow-y: auto; padding: 4px 12px; border-bottom: 1px solid #2a2a4e; display: none; }}
  .search-item {{ padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .search-item:hover {{ background: #2a2a4e; }}
  #info-panel {{ padding: 14px; border-bottom: 1px solid #2a2a4e; min-height: 140px; }}
  #info-panel h3 {{ font-size: 13px; color: #aaa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }}
  #info-content {{ font-size: 13px; color: #ccc; line-height: 1.6; }}
  #info-content .field {{ margin-bottom: 5px; }}
  #info-content .field b {{ color: #e0e0e0; }}
  #info-content .empty {{ color: #555; font-style: italic; }}
  .neighbor-link {{ display: block; padding: 2px 6px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 3px solid #333; }}
  .neighbor-link:hover {{ background: #2a2a4e; }}
  #neighbors-list {{ max-height: 200px; overflow-y: auto; margin-top: 4px; }}
  #file-view {{ display: none; flex-direction: column; border-bottom: 1px solid #2a2a4e; }}
  #file-view.open {{ display: flex; flex: 1; min-height: 0; }}
  #file-view-header {{ padding: 8px 14px; display: flex; justify-content: space-between; align-items: center; background: #16162a; font-size: 11px; color: #aaa; }}
  #file-view-close {{ cursor: pointer; color: #888; background: none; border: none; font-size: 14px; }}
  #file-view-close:hover {{ color: #e0e0e0; }}
  #file-view-body {{ flex: 1; overflow: auto; margin: 0; padding: 10px 14px; font-size: 11px; line-height: 1.5; font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: pre; color: #ccc; }}
  #path-filter-wrap {{ border-bottom: 1px solid #2a2a4e; padding: 12px; height: 320px; display: flex; flex-direction: column; overflow: hidden; }}
  #sidebar.viewing-file #path-filter-wrap {{ display: none; }}
  #path-filter-wrap h3 {{ font-size: 13px; color: #aaa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }}
  #path-filter-tree {{ flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; font-size: 12px; }}
  #path-filter-tree details {{ margin-left: 14px; min-width: 0; }}
  #path-filter-tree > details {{ margin-left: 0; }}
  #path-filter-tree summary {{ list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 2px 0; user-select: none; min-width: 0; }}
  #path-filter-tree summary::-webkit-details-marker {{ display: none; }}
  #path-filter-tree summary::before {{ content: '\u25b8'; color: #666; font-size: 10px; display: inline-block; width: 10px; transition: transform 0.1s; flex-shrink: 0; }}
  #path-filter-tree details[open] > summary::before {{ transform: rotate(90deg); }}
  .tree-file {{ display: flex; align-items: center; gap: 6px; padding: 2px 0; margin-left: 14px; cursor: pointer; user-select: none; min-width: 0; }}
  .tree-cb {{ appearance: none; -webkit-appearance: none; width: 13px; height: 13px; border: 1.5px solid #3a3a5e; border-radius: 3px; background: #0f0f1a; cursor: pointer; position: relative; flex-shrink: 0; }}
  .tree-cb:checked {{ background: #4E79A7; border-color: #4E79A7; }}
  .tree-cb:checked::after {{ content: ''; position: absolute; left: 3px; top: 1px; width: 3px; height: 6px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }}
  .tree-cb:indeterminate {{ background: #4E79A7; border-color: #4E79A7; }}
  .tree-cb:indeterminate::after {{ content: ''; position: absolute; left: 2px; top: 5px; width: 7px; height: 2px; background: #fff; border: none; }}
  .tree-name {{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ccc; }}
  .tree-count {{ color: #666; font-size: 10px; flex-shrink: 0; }}
  #legend-wrap {{ flex: 1; overflow-y: auto; padding: 12px; }}
  #sidebar.viewing-file #legend-wrap {{ display: none; }}
  #legend-wrap h3 {{ font-size: 13px; color: #aaa; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }}
  .legend-item {{ display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }}
  .legend-dot {{ width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }}
  .legend-label {{ flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .legend-count {{ color: #666; font-size: 11px; }}
  #stats {{ padding: 10px 14px; border-top: 1px solid #2a2a4e; font-size: 11px; color: #555; }}
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search files..." autocomplete="off">
    <div id="search-results"></div>
  </div>
  <div id="info-panel">
    <h3>File Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="file-view">
    <div id="file-view-header">
      <span id="file-view-path"></span>
      <button id="file-view-close" title="Close">&times;</button>
    </div>
    <pre id="file-view-body"></pre>
  </div>
  <div id="path-filter-wrap">
    <h3>Filter by Path</h3>
    <div id="path-filter-tree"></div>
  </div>
  <div id="legend-wrap">
    <h3>Import Clusters (by shared folder)</h3>
    <div id="legend"></div>
  </div>
  <div id="stats">{len(vis_nodes)} files &middot; {len(vis_edges)} import edges &middot; {len(community_members)} clusters</div>
</div>
<script>
function esc(s) {{ const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }}
const RAW_NODES = {json_for_script(vis_nodes)};
const RAW_EDGES = {json_for_script(vis_edges)};
const LEGEND = {json_for_script(legend)};
const FILE_CONTENTS = {json_for_script(file_contents)};

const nodesDS = new vis.DataSet(RAW_NODES);
const edgesDS = new vis.DataSet(RAW_EDGES);
const container = document.getElementById('graph');
const network = new vis.Network(container, {{ nodes: nodesDS, edges: edgesDS }}, {{
  layout: {{ improvedLayout: true }},
  physics: {{
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {{ gravitationalConstant: -50, centralGravity: 0.008, springLength: 90, springConstant: 0.1, damping: 0.4, avoidOverlap: 0.6 }},
    stabilization: {{ iterations: 200, fit: true }},
  }},
  interaction: {{ hover: true, tooltipDelay: 100, hideEdgesOnDrag: true }},
  nodes: {{ shape: 'dot', borderWidth: 1.5 }},
  edges: {{ smooth: {{ type: 'continuous', roundness: 0.2 }}, arrows: {{ to: {{ scaleFactor: 0.4 }} }} }},
}});
network.once('stabilizationIterationsDone', () => network.setOptions({{ physics: {{ enabled: false }} }}));

function showInfo(nodeId) {{
  const n = nodesDS.get(nodeId);
  if (!n) return;
  const outNbrs = network.getConnectedNodes(nodeId, 'to');
  const inNbrs = network.getConnectedNodes(nodeId, 'from');
  const renderList = (ids) => ids.map(nid => {{
    const nb = nodesDS.get(nid);
    const color = nb ? nb.color.background : '#555';
    return `<span class="neighbor-link" style="border-left-color:${{esc(color)}}" data-nid="${{esc(nid)}}">${{esc(nb ? nb._source_file : nid)}}</span>`;
  }}).join('');
  const hasContent = Object.prototype.hasOwnProperty.call(FILE_CONTENTS, n._source_file);
  document.getElementById('info-content').innerHTML = `
    <div class="field"><b>${{esc(n._source_file)}}</b></div>
    <div class="field">Cluster: ${{esc(n._community_name)}}</div>
    <div class="field">Degree: ${{n._degree}}</div>
    <div class="field" style="margin-top:8px">${{hasContent
      ? `<span class="neighbor-link" style="border-left-color:#4E79A7" data-view-file="${{esc(n._source_file)}}">View file contents</span>`
      : '<span class="empty">file too large to preview inline, or not found on disk</span>'}}</div>
    ${{outNbrs.length ? `<div class="field" style="margin-top:8px;color:#aaa;font-size:11px">Imports (${{outNbrs.length}})</div><div id="neighbors-list">${{renderList(outNbrs)}}</div>` : ''}}
    ${{inNbrs.length ? `<div class="field" style="margin-top:8px;color:#aaa;font-size:11px">Imported by (${{inNbrs.length}})</div><div id="neighbors-list">${{renderList(inNbrs)}}</div>` : ''}}
  `;
}}

function focusNode(nodeId) {{
  focusedNodeId = nodeId;
  network.focus(nodeId, {{ scale: 1.4, animation: true }});
  network.selectNodes([nodeId]);
  showInfo(nodeId);
  applyFilter();
}}

function openFileView(sourceFile) {{
  const content = FILE_CONTENTS[sourceFile];
  if (content === undefined) return;
  document.getElementById('file-view-path').textContent = sourceFile;
  document.getElementById('file-view-body').textContent = content;
  document.getElementById('file-view').classList.add('open');
  document.getElementById('sidebar').classList.add('viewing-file');
}}

document.getElementById('file-view-close').addEventListener('click', () => {{
  document.getElementById('file-view').classList.remove('open');
  document.getElementById('sidebar').classList.remove('viewing-file');
}});

document.addEventListener('click', e => {{
  const viewEl = e.target.closest('[data-view-file]');
  if (viewEl) {{ openFileView(viewEl.dataset.viewFile); return; }}
  const el = e.target.closest('.neighbor-link');
  if (el && el.dataset.nid !== undefined) focusNode(el.dataset.nid);
}});

network.on('click', params => {{
  if (params.nodes.length > 0) {{
    focusedNodeId = params.nodes[0];
    showInfo(focusedNodeId);
    applyFilter();
  }} else if (focusedNodeId !== null) {{
    // clicking empty canvas resets the isolation back to the full (filtered) graph
    focusedNodeId = null;
    applyFilter();
  }}
}});

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
searchInput.addEventListener('input', () => {{
  const q = searchInput.value.toLowerCase().trim();
  searchResults.innerHTML = '';
  if (!q) {{ searchResults.style.display = 'none'; return; }}
  const matches = RAW_NODES.filter(n => n._source_file.toLowerCase().includes(q)).slice(0, 20);
  if (!matches.length) {{ searchResults.style.display = 'none'; return; }}
  searchResults.style.display = 'block';
  matches.forEach(n => {{
    const el = document.createElement('div');
    el.className = 'search-item';
    el.textContent = n._source_file;
    el.addEventListener('click', () => {{ focusNode(n.id); searchResults.style.display = 'none'; searchInput.value = ''; }});
    searchResults.appendChild(el);
  }});
}});

const legendEl = document.getElementById('legend');
LEGEND.forEach(c => {{
  const item = document.createElement('div');
  item.className = 'legend-item';
  item.innerHTML = `<div class="legend-dot" style="background:${{esc(c.color)}}"></div><div class="legend-label">${{esc(c.label)}}</div><div class="legend-count">${{c.count}}</div>`;
  legendEl.appendChild(item);
}});

// Path filter -- a real folder tree, computed from whatever RAW_NODES
// actually holds (nothing about any specific path is hardcoded). Every
// folder AND every individual file gets its own checkbox, so you can
// exclude a whole top-level directory or one file like
// "agent-feed/wire/index.ts" -- the depth you filter at is up to you.
function buildTree(nodes) {{
  const root = {{ name: '', children: new Map(), fileId: null }};
  nodes.forEach(n => {{
    const parts = n._source_file.split('/');
    let cur = root;
    parts.forEach((part, i) => {{
      if (!cur.children.has(part)) cur.children.set(part, {{ name: part, children: new Map(), fileId: null }});
      cur = cur.children.get(part);
      if (i === parts.length - 1) cur.fileId = n.id;
    }});
  }});
  return root;
}}

function collectLeafIds(node, out) {{
  out = out || [];
  if (node.fileId !== null) out.push(node.fileId);
  node.children.forEach(child => collectLeafIds(child, out));
  return out;
}}

const tree = buildTree(RAW_NODES);
const excludedIds = new Set();
const folderCheckboxes = [];  // {{ el, leafIds }}
const fileCheckboxes = [];    // {{ el, id }}

// Clicking a node isolates it plus its immediate (1-hop, either direction)
// connections on the canvas -- everything else hides until you click empty
// canvas or another node. This composes with the path filter: a file
// excluded there stays hidden even inside a focused neighborhood.
let focusedNodeId = null;

function applyFilter() {{
  const focusSet = focusedNodeId !== null
    ? new Set([focusedNodeId, ...network.getConnectedNodes(focusedNodeId)])
    : null;
  const isHidden = (id) => excludedIds.has(id) || (focusSet !== null && !focusSet.has(id));

  nodesDS.update(RAW_NODES.map(n => ({{ id: n.id, hidden: isHidden(n.id) }})));

  const visibleCount = RAW_NODES.filter(n => !isHidden(n.id)).length;
  const visibleEdgeCount = RAW_EDGES.filter(e => !isHidden(e.from) && !isHidden(e.to)).length;
  const focusNote = focusSet !== null
    ? ` · showing ${{focusSet.size}} connected file${{focusSet.size === 1 ? '' : 's'}} (click empty canvas to reset)`
    : '';
  document.getElementById('stats').textContent =
    `${{visibleCount}} files (${{RAW_NODES.length}} total) · ${{visibleEdgeCount}} import edges · {len(community_members)} clusters${{focusNote}}`;
}}

function syncCheckboxes() {{
  fileCheckboxes.forEach(({{ el, id }}) => {{ el.checked = !excludedIds.has(id); el.indeterminate = false; }});
  folderCheckboxes.forEach(({{ el, leafIds }}) => {{
    const excludedCount = leafIds.filter(id => excludedIds.has(id)).length;
    el.checked = excludedCount === 0;
    el.indeterminate = excludedCount > 0 && excludedCount < leafIds.length;
  }});
}}

function renderNode(node) {{
  const leafIds = collectLeafIds(node);
  const isFile = node.children.size === 0;

  if (isFile) {{
    const row = document.createElement('label');
    row.className = 'tree-file';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tree-cb';
    cb.checked = true;
    cb.addEventListener('change', () => {{
      if (cb.checked) excludedIds.delete(node.fileId); else excludedIds.add(node.fileId);
      syncCheckboxes();
      applyFilter();
    }});
    fileCheckboxes.push({{ el: cb, id: node.fileId }});
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    row.appendChild(cb);
    row.appendChild(name);
    return row;
  }}

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'tree-cb';
  cb.checked = true;
  cb.addEventListener('click', e => e.stopPropagation());  // don't toggle expand/collapse
  cb.addEventListener('change', () => {{
    if (cb.checked) leafIds.forEach(id => excludedIds.delete(id));
    else leafIds.forEach(id => excludedIds.add(id));
    syncCheckboxes();
    applyFilter();
  }});
  folderCheckboxes.push({{ el: cb, leafIds }});
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name || '/';
  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = leafIds.length;
  summary.appendChild(cb);
  summary.appendChild(name);
  summary.appendChild(count);
  details.appendChild(summary);

  const childNames = Array.from(node.children.keys()).sort((a, b) => a.localeCompare(b));
  childNames.forEach(name => {{
    details.appendChild(renderNode(node.children.get(name)));
  }});
  return details;
}}

const treeEl = document.getElementById('path-filter-tree');
Array.from(tree.children.keys()).sort((a, b) => a.localeCompare(b)).forEach(name => {{
  treeEl.appendChild(renderNode(tree.children.get(name)));
}});
</script>
</body>
</html>"""

    with open(out_path, "w") as f:
        f.write(html)


def main():
    if len(sys.argv) != 4:
        print("usage: graphify-import-graph.py <graph.json> <output.html> <repo-root>", file=sys.stderr)
        sys.exit(1)
    graph_json_path, out_path, repo_root = sys.argv[1], sys.argv[2], sys.argv[3]
    G = build_file_import_graph(graph_json_path)
    node_community = cluster(G)
    render_html(G, node_community, out_path, repo_root)
    print(f"files: {G.number_of_nodes()} | import edges: {G.number_of_edges()} | clusters: {len(set(node_community.values()))}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
