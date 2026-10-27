// @ts-check
/* global cytoscape, cytoscapeDagre, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  if (typeof cytoscapeDagre !== 'undefined') {
    try { cytoscape.use(cytoscapeDagre); } catch { /* already registered */ }
  }

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const statusEl = $('status');
  const detailsEl = $('details');
  const btnExpand = /** @type {HTMLButtonElement} */ ($('btn-expand'));
  const btnExpand3 = /** @type {HTMLButtonElement} */ ($('btn-expand3'));
  const btnReroot = /** @type {HTMLButtonElement} */ ($('btn-reroot'));
  const btnDir = /** @type {HTMLButtonElement} */ ($('btn-dir'));

  let direction = 'TB';
  let rootId = '';
  /** Keep fitting the whole graph after each layout until the user pans or zooms. */
  let autoFit = true;
  const loading = new Set();

  // ---------- Theme ----------
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function themeStyle() {
    const fg = cssVar('--vscode-editor-foreground', '#cccccc');
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    const nodeBg = cssVar('--vscode-editorWidget-background', '#252526');
    const border = cssVar('--vscode-editorWidget-border', '#454545');
    const accent = cssVar('--vscode-focusBorder', '#007fd4');
    const root = cssVar('--vscode-charts-green', '#89d185');
    const line = cssVar('--vscode-editorLineNumber-foreground', '#858585');
    const cond = cssVar('--vscode-charts-yellow', '#cca700');
    const purple = cssVar('--vscode-charts-purple', '#c586c0');
    const orange = cssVar('--vscode-charts-orange', '#d18616');
    const mono = cssVar('--vscode-editor-font-family', 'monospace');

    return [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          label: 'data(label)',
          'text-wrap': 'wrap',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': 12,
          'font-family': mono,
          color: fg,
          'background-color': nodeBg,
          'border-width': 1.5,
          'border-color': border,
          width: 'data(w)',
          height: 'data(h)'
        }
      },
      { selector: 'node[?collapsed]', style: { 'border-style': 'dashed' } },
      { selector: 'node[?isRoot]', style: { 'border-color': root, 'border-width': 2.5 } },
      { selector: 'node[?loading]', style: { opacity: 0.55 } },
      { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 3 } },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.1,
          'line-color': line,
          'target-arrow-color': line,
          // Labels sit near the callee end: edges fan out from the caller, so midpoints collide.
          'target-label': 'data(label)',
          'target-text-offset': 58,
          'font-size': 11,
          'font-family': mono,
          color: cond,
          'text-wrap': 'wrap',
          'text-max-width': '190px',
          'text-background-color': bg,
          'text-background-opacity': 0.9,
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle'
        }
      },
      {
        selector: 'edge[dispatchKind = "interface"]',
        style: { 'line-style': 'dashed', 'line-color': purple, 'target-arrow-color': purple }
      },
      {
        selector: 'edge[dispatchKind = "virtual"]',
        style: { 'line-style': 'dotted', 'line-color': orange, 'target-arrow-color': orange }
      },
      { selector: 'edge:selected', style: { width: 3, 'line-color': accent, 'target-arrow-color': accent } },
      { selector: ':loop', style: { 'loop-direction': '-45deg', 'loop-sweep': '-60deg' } }
    ];
  }

  const cy = cytoscape({
    container: $('cy'),
    style: themeStyle(),
    wheelSensitivity: 0.25,
    minZoom: 0.1,
    maxZoom: 3,
    boxSelectionEnabled: false
  });

  // VS Code swaps body classes when the color theme changes.
  new MutationObserver(() => cy.style(themeStyle())).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  // ---------- Rendering ----------
  function fileName(p) {
    return String(p).split(/[\\/]/).pop();
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  /** Label and explicit size (label-based sizing mis-measures before webview fonts settle). */
  function updateNodeLabel(n) {
    const fn = n.data('fn');
    const lines = [`${fn.name}${n.data('collapsed') ? '  ＋' : ''}`, `${fileName(fn.filePath)}:${fn.line}`];
    const guard = n.data('guard') || [];
    if (guard.length) lines.push(truncate(`guard: ${guard.join(' && ')}`, 60));
    const longest = Math.max(...lines.map(l => l.length));
    n.data({ label: lines.join('\n'), w: Math.round(longest * 7.4 + 24), h: lines.length * 16 + 14 });
  }

  function addNode(fn, isRoot) {
    if (cy.getElementById(fn.id).nonempty()) return;
    const n = cy.add({ group: 'nodes', data: { id: fn.id, fn, isRoot: !!isRoot, collapsed: true, guard: [] } });
    updateNodeLabel(n);
  }

  function setCollapsed(id, collapsed) {
    const n = cy.getElementById(id);
    if (n.empty()) return;
    n.data('collapsed', collapsed);
    updateNodeLabel(n);
  }

  /**
   * Adds one call to the visual edge between its caller and callee. Several calls between the same pair
   * (e.g. the same method called from two branches) share one arrow with one label line per call.
   */
  function addCall(call) {
    const id = `${call.source}=>${call.target}`;
    const existing = cy.getElementById(id);
    if (existing.nonempty()) {
      const calls = existing.data('calls');
      if (!calls.some(c => c.id === call.id)) existing.data('calls', [...calls, call]);
      return;
    }
    cy.add({
      group: 'edges',
      data: { id, source: call.source, target: call.target, dispatchKind: call.dispatchKind, calls: [call], label: '' }
    });
  }

  function callText(call, common) {
    const parts = (call.conditionParts || []).filter(p => !common.includes(p));
    const ctx = call.context || [];
    return [ctx.length ? `[${ctx.join(' › ')}]` : '', parts.join(' && ')].filter(Boolean).join(' ');
  }

  /**
   * Conditions shared by every drawn call of a function (typically guard clauses) are shown once on the
   * node as "guard: ..."; each edge keeps only what distinguishes it. The full condition stays in details.
   */
  function relabelOutgoing(n) {
    const edges = n.outgoers('edge');
    const calls = edges.map(e => e.data('calls')).flat();
    let common = [];
    if (calls.length >= 2) {
      const first = calls[0].conditionParts || [];
      common = first.filter(part => calls.every(c => (c.conditionParts || []).includes(part)));
    }
    n.data('guard', common);
    updateNodeLabel(n);
    edges.forEach(e => {
      const texts = [...new Set(e.data('calls').map(c => callText(c, common)))];
      const label = texts.length > 1 ? texts.map(t => t || '(always)').join('\nor ') : texts[0];
      e.data('label', truncate(label, 160));
    });
  }

  function runLayout() {
    const layout = cy.layout(/** @type {any} */ ({
      name: typeof cytoscapeDagre !== 'undefined' ? 'dagre' : 'breadthfirst',
      rankDir: direction,
      directed: true,
      nodeSep: 80,
      rankSep: 110,
      edgeSep: 20,
      fit: autoFit,
      padding: 40,
      animate: false
    }));
    layout.run();
    // Small graphs should not be blown up past a readable zoom.
    if (autoFit && cy.zoom() > 1.2) {
      cy.zoom(1.2);
      cy.center();
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.className = isError ? 'error' : '';
  }

  function updateLoadingStatus() {
    setStatus(loading.size ? `Analyzing ${loading.size} function(s)…` : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showDetails(ele) {
    if (!ele) {
      detailsEl.hidden = true;
      return;
    }
    if (ele.isNode()) {
      const fn = ele.data('fn');
      const outgoing = ele.outgoers('edge').length;
      detailsEl.innerHTML =
        `<div><code>${escapeHtml(fn.signature)}</code></div>` +
        `<div class="muted">${escapeHtml(fn.containingType)}</div>` +
        `<div class="muted">${escapeHtml(fn.filePath)}:${fn.line}</div>` +
        ((ele.data('guard') || []).length
          ? `<div>all calls require <code>${escapeHtml(ele.data('guard').join(' && '))}</code></div>` : '') +
        `<div class="muted">${ele.data('collapsed') ? 'not expanded yet' : `${outgoing} outgoing call(s)`}</div>`;
    } else {
      const src = ele.source().data('fn');
      const tgt = ele.target().data('fn');
      const calls = ele.data('calls')
        .map(c =>
          `<div>${c.condition ? `when <code>${escapeHtml(c.condition)}</code>` : '<span class="muted">unconditional</span>'}` +
          ` <span class="muted">· ${escapeHtml(fileName(c.callFilePath))}:${c.callLine}</span></div>`)
        .join('');
      detailsEl.innerHTML =
        `<div><code>${escapeHtml(src.name)}</code> → <code>${escapeHtml(tgt.name)}</code>` +
        ` <span class="muted">(${escapeHtml(ele.data('dispatchKind'))})</span></div>` + calls;
    }
    detailsEl.hidden = false;
  }

  function selectedNode() {
    const sel = cy.$('node:selected');
    return sel.nonempty() ? sel[0] : null;
  }

  function updateButtons() {
    const n = selectedNode();
    btnExpand.disabled = btnExpand3.disabled = !n;
    btnReroot.disabled = !n || n.id() === rootId;
  }

  // ---------- Messages from extension ----------
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'reset':
        cy.elements().remove();
        loading.clear();
        autoFit = true;
        rootId = msg.root.id;
        direction = msg.direction || direction;
        btnDir.textContent = `Direction: ${direction}`;
        addNode(msg.root, true);
        runLayout();
        showDetails(null);
        updateButtons();
        setStatus('');
        break;

      case 'add': {
        cy.batch(() => {
          for (const fn of msg.nodes) addNode(fn, false);
          for (const e of msg.edges) addCall(e);
          for (const id of msg.expanded) setCollapsed(id, false);
          new Set(msg.edges.map(e => e.source)).forEach(id => relabelOutgoing(cy.getElementById(id)));
        });
        runLayout();
        break;
      }

      case 'loading':
        for (const id of msg.ids) {
          if (msg.on) loading.add(id); else loading.delete(id);
          const n = cy.getElementById(id);
          if (n.nonempty()) n.data('loading', msg.on);
        }
        updateLoadingStatus();
        break;

      case 'error':
        setStatus(msg.message, true);
        break;
    }
  });

  // ---------- User interaction ----------
  function expand(node, depth) {
    if (!node) return;
    vscode.postMessage({ type: 'expand', id: node.id(), depth });
  }

  cy.on('tap', 'node', evt => {
    showDetails(evt.target);
    setTimeout(updateButtons, 0);
  });
  cy.on('dbltap', 'node', evt => vscode.postMessage({ type: 'jumpToNode', id: evt.target.id() }));
  cy.on('cxttap', 'node', evt => {
    evt.target.select();
    expand(evt.target, 1);
  });
  cy.on('tap', 'edge', evt => {
    showDetails(evt.target);
    vscode.postMessage({ type: 'jumpToCall', edgeId: evt.target.data('calls')[0].id });
  });
  // Any manual pan/zoom stops auto-fitting so expanding does not yank the viewport away.
  cy.on('pan zoom', evt => {
    if (evt.originalEvent) autoFit = false;
  });
  $('cy').addEventListener('wheel', () => (autoFit = false), { passive: true });
  cy.on('tap', evt => {
    if (evt.target === cy) {
      showDetails(null);
      setTimeout(updateButtons, 0);
    }
  });
  cy.on('select unselect', 'node', updateButtons);

  $('btn-fit').addEventListener('click', () => {
    autoFit = true;
    cy.fit(undefined, 40);
  });
  btnDir.addEventListener('click', () => {
    direction = direction === 'TB' ? 'LR' : 'TB';
    btnDir.textContent = `Direction: ${direction}`;
    autoFit = true;
    runLayout();
  });
  btnExpand.addEventListener('click', () => expand(selectedNode(), 1));
  btnExpand3.addEventListener('click', () => expand(selectedNode(), 3));
  btnReroot.addEventListener('click', () => {
    const n = selectedNode();
    if (n) vscode.postMessage({ type: 'reroot', id: n.id() });
  });

  vscode.postMessage({ type: 'ready' });
})();
