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

  /** Fit never zooms out further than this: past it text is too small to read. Pan to see the rest. */
  const MIN_FIT_ZOOM = 0.8;
  const MAX_FIT_ZOOM = 1.2;
  /** Condition boxes wrap at this many characters per line and show at most this many lines. */
  const LABEL_COLS = 46;
  const LABEL_MAX_LINES = 6;

  let direction = 'TB';
  let rootId = '';
  /** 'call' = function call flow, 'class' = class flow. */
  let mode = 'call';
  /** Keep fitting the whole graph after each layout until the user pans or zooms. */
  let autoFit = true;
  const loading = new Set();

  /**
   * Calls grouped per (caller, callee) pair. A group is drawn either as one plain arrow (no condition)
   * or as caller ─ [condition box] ─▶ callee. Condition boxes are real nodes, so the layout reserves
   * space for them and they never cover function nodes or each other.
   * @type {Map<string, {id: string, source: string, target: string, edgeKind: string, calls: any[], label: string}>}
   */
  const groups = new Map();

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
    const blue = cssVar('--vscode-charts-blue', '#3794ff');
    const green = cssVar('--vscode-charts-green', '#89d185');
    const muted = cssVar('--vscode-descriptionForeground', '#9d9d9d');

    return [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          label: 'data(label)',
          'text-wrap': 'wrap',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': 13,
          'font-family': mono,
          color: fg,
          'background-color': nodeBg,
          'border-width': 1.5,
          'border-color': border,
          width: 'data(w)',
          height: 'data(h)'
        }
      },
      { selector: 'node.fn[?collapsed]', style: { 'border-style': 'dashed' } },
      { selector: 'node.fn[?isRoot]', style: { 'border-color': root, 'border-width': 2.5 } },
      { selector: 'node[?loading]', style: { opacity: 0.55 } },
      {
        selector: 'node.cond',
        style: {
          'background-color': bg,
          'border-color': line,
          'border-width': 1,
          color: cond,
          'font-size': 13,
          'font-weight': 600
        }
      },
      { selector: 'node.cond[edgeKind = "interface"], node.cond[edgeKind = "implements"]', style: { 'border-color': purple, 'border-style': 'dashed' } },
      { selector: 'node.cond[edgeKind = "virtual"]', style: { 'border-color': orange, 'border-style': 'dotted' } },
      { selector: 'node.cond[edgeKind = "injects"]', style: { 'border-color': blue } },
      { selector: 'node.cond[edgeKind = "creates"]', style: { 'border-color': orange } },
      { selector: 'node.cond[edgeKind = "registers"], node.cond[edgeKind = "binds"]', style: { 'border-color': green, 'border-style': 'dashed' } },
      // Class view: node role at a glance.
      { selector: 'node.fn[kind = "interface"]', style: { 'font-style': 'italic', 'border-style': 'dashed', 'border-color': purple } },
      { selector: 'node.fn[kind = "controller"]', style: { 'border-color': blue, 'border-width': 2 } },
      { selector: 'node.fn[kind = "background service"]', style: { 'border-color': orange, 'border-width': 2 } },
      { selector: 'node.fn[kind = "di"]', style: { 'border-color': green, 'border-width': 2, 'background-color': bg } },
      { selector: 'node.fn[kind = "abstract class"]', style: { 'font-style': 'italic' } },
      { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 3 } },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.1,
          'line-color': line,
          'target-arrow-color': line
        }
      },
      {
        selector: 'edge[edgeKind = "interface"]',
        style: { 'line-style': 'dashed', 'line-color': purple, 'target-arrow-color': purple }
      },
      {
        selector: 'edge[edgeKind = "virtual"]',
        style: { 'line-style': 'dotted', 'line-color': orange, 'target-arrow-color': orange }
      },
      // Class view (UML-like): hollow triangle = inheritance / implementation.
      { selector: 'edge[edgeKind = "inherits"]', style: { 'line-color': muted, 'target-arrow-color': muted, 'target-arrow-fill': 'hollow', 'arrow-scale': 1.5 } },
      {
        selector: 'edge[edgeKind = "implements"]',
        style: { 'line-style': 'dashed', 'line-color': purple, 'target-arrow-color': purple, 'target-arrow-fill': 'hollow', 'arrow-scale': 1.5 }
      },
      { selector: 'edge[edgeKind = "injects"]', style: { 'line-color': blue, 'target-arrow-color': blue } },
      { selector: 'edge[edgeKind = "creates"]', style: { 'line-color': orange, 'target-arrow-color': orange, 'target-arrow-shape': 'vee' } },
      { selector: 'edge[edgeKind = "binds"]', style: { 'line-style': 'dashed', 'line-color': green, 'target-arrow-color': green } },
      { selector: 'edge[edgeKind = "registers"]', style: { 'line-style': 'dotted', 'line-color': green, 'target-arrow-color': green } },
      { selector: 'edge.to-cond', style: { 'target-arrow-shape': 'none' } },
      { selector: 'edge.hl', style: { width: 3, 'line-color': accent, 'target-arrow-color': accent } },
      { selector: ':loop', style: { 'loop-direction': '-45deg', 'loop-sweep': '-60deg' } }
    ];
  }

  const cy = cytoscape({
    container: $('cy'),
    style: themeStyle(),
    wheelSensitivity: 0.25,
    minZoom: 0.1,
    maxZoom: 3,
    boxSelectionEnabled: false,
    pixelRatio: 'auto',
    textureOnViewport: false,
    motionBlur: false
  });

  // VS Code swaps body classes when the color theme changes.
  new MutationObserver(() => cy.style(themeStyle())).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  // ---------- Text helpers ----------
  function fileName(p) {
    return String(p).split(/[\\/]/).pop();
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  /** Word-wraps at operators/spaces so long conditions become a compact box. */
  function wrap(text, cols) {
    const out = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        if (line && (line + ' ' + word).length > cols) {
          out.push(line);
          line = word;
        } else {
          line = line ? line + ' ' + word : word;
        }
        while (line.length > cols) {
          out.push(line.slice(0, cols));
          line = line.slice(cols);
        }
      }
      out.push(line);
    }
    return out;
  }

  /** Explicit box size from the text (label-based sizing mis-measures before webview fonts settle). */
  function boxSize(lines, charWidth, lineHeight) {
    const longest = Math.max(...lines.map(l => l.length));
    return { w: Math.round(longest * charWidth + 22), h: lines.length * lineHeight + 14 };
  }

  // ---------- Function nodes ----------
  function updateNodeLabel(n) {
    const fn = n.data('fn');
    const where = `${fileName(fn.filePath)}:${fn.line}`;
    const second = mode === 'class' && fn.kind !== 'di' ? `${fn.kind} · ${where}` : where;
    const lines = [`${fn.name}${n.data('collapsed') ? '  ＋' : ''}`, second];
    const guard = n.data('guard') || [];
    if (guard.length) lines.push(truncate(`guard: ${guard.join(' && ')}`, 60));
    n.data({ label: lines.join('\n'), ...boxSize(lines, 8, 17) });
  }

  function addNode(fn, isRoot) {
    if (cy.getElementById(fn.id).nonempty()) return;
    const n = cy.add({
      group: 'nodes',
      classes: 'fn',
      data: { id: fn.id, fn, kind: fn.kind, isRoot: !!isRoot, collapsed: true, guard: [] }
    });
    updateNodeLabel(n);
  }

  function setCollapsed(id, collapsed) {
    const n = cy.getElementById(id);
    if (n.empty()) return;
    n.data('collapsed', collapsed);
    updateNodeLabel(n);
  }

  // ---------- Call groups ----------
  function addCall(call) {
    const id = `${call.source}=>${call.target}:${call.edgeKind}`;
    const g = groups.get(id);
    if (g) {
      if (!g.calls.some(c => c.id === call.id)) g.calls.push(call);
      return;
    }
    groups.set(id, { id, source: call.source, target: call.target, edgeKind: call.edgeKind, calls: [call], label: '' });
  }

  function callText(call, common) {
    if (call.label !== undefined && call.label !== null) return call.label; // class view
    const parts = (call.conditionParts || []).filter(p => !common.includes(p));
    const ctx = call.context || [];
    return [ctx.length ? `[${ctx.join(' › ')}]` : '', parts.join(' && ')].filter(Boolean).join(' ');
  }

  function outgoingGroups(sourceId) {
    return [...groups.values()].filter(g => g.source === sourceId);
  }

  /**
   * Conditions shared by every drawn call of a function (typically guard clauses) are shown once on the
   * node as "guard: ..."; each group keeps only what distinguishes it. The full condition stays in details.
   */
  function relabelOutgoing(sourceId) {
    const n = cy.getElementById(sourceId);
    const out = outgoingGroups(sourceId);
    const calls = out.flatMap(g => g.calls);
    let common = [];
    if (calls.length >= 2) {
      const first = calls[0].conditionParts || [];
      common = first.filter(part => calls.every(c => (c.conditionParts || []).includes(part)));
    }
    n.data('guard', common);
    updateNodeLabel(n);
    for (const g of out) {
      const texts = [...new Set(g.calls.map(c => callText(c, common)))];
      g.label = mode === 'class'
        ? texts.filter(Boolean).join('\n')
        : texts.length > 1 ? texts.map(t => t || '(always)').join('\nor ') : texts[0];
      drawGroup(g);
    }
  }

  /** Creates/updates the Cytoscape elements of one group to match its current label. */
  function drawGroup(g) {
    const condId = `cond:${g.id}`;
    const ids = { cond: condId, a: `${g.id}#a`, b: `${g.id}#b`, direct: `${g.id}#d` };
    const common = { group: g.id, edgeKind: g.edgeKind };

    if (!g.label) {
      cy.remove(cy.getElementById(ids.cond)); // also removes #a/#b
      if (cy.getElementById(ids.direct).empty()) {
        cy.add({ group: 'edges', data: { id: ids.direct, source: g.source, target: g.target, ...common } });
      }
      return;
    }

    cy.remove(cy.getElementById(ids.direct));
    let lines = wrap(g.label, LABEL_COLS);
    if (lines.length > LABEL_MAX_LINES) lines = [...lines.slice(0, LABEL_MAX_LINES - 1), '… (click for full condition)'];
    const data = { label: lines.join('\n'), ...boxSize(lines, 8, 17), ...common };

    const box = cy.getElementById(ids.cond);
    if (box.nonempty()) {
      box.data(data);
      return;
    }
    cy.add([
      { group: 'nodes', classes: 'cond', data: { id: ids.cond, ...data } },
      { group: 'edges', classes: 'to-cond', data: { id: ids.a, source: g.source, target: ids.cond, ...common } },
      { group: 'edges', data: { id: ids.b, source: ids.cond, target: g.target, ...common } }
    ]);
  }

  // ---------- Layout ----------
  function fitView() {
    cy.fit(undefined, 40);
    const z = cy.zoom();
    if (z > MAX_FIT_ZOOM) {
      cy.zoom(MAX_FIT_ZOOM);
      cy.center();
    } else if (z < MIN_FIT_ZOOM) {
      // Too big to fit legibly: stay readable and start at the root (top / left edge of the graph).
      cy.zoom(MIN_FIT_ZOOM);
      const root = cy.getElementById(rootId);
      if (root.nonempty()) {
        const p = root.renderedPosition();
        const h = cy.height(), w = cy.width();
        cy.panBy(direction === 'TB'
          ? { x: w / 2 - p.x, y: 60 - p.y + root.renderedHeight() / 2 }
          : { x: 60 - p.x + root.renderedWidth() / 2, y: h / 2 - p.y });
      }
    }
  }

  function runLayout() {
    cy.layout(/** @type {any} */ ({
      name: typeof cytoscapeDagre !== 'undefined' ? 'dagre' : 'breadthfirst',
      rankDir: direction,
      directed: true,
      nodeSep: 30,
      rankSep: 40,
      edgeSep: 10,
      fit: false,
      animate: false
    })).run();
    if (autoFit) fitView();
  }

  // ---------- Legend ----------
  const KIND_TEXT = {
    direct: 'direct call', interface: 'call via interface (DI)', virtual: 'virtual/override call',
    inherits: 'inherits', implements: 'implements', injects: 'injected via constructor',
    creates: 'creates (new)', binds: 'DI: interface → implementation', registers: 'registered in DI'
  };
  const LEGEND = {
    call: [['direct', 'solid', 'line'], ['interface', 'dashed', 'purple'], ['virtual', 'dotted', 'orange']],
    class: [
      ['inherits', 'solid', 'muted'], ['implements', 'dashed', 'purple'], ['injects', 'solid', 'blue'],
      ['creates', 'solid', 'orange'], ['binds', 'dashed', 'green'], ['registers', 'dotted', 'green']
    ]
  };
  const HINT = {
    call: 'Right-click a node (or ＋) to expand · double-click a node to open it · click a condition/arrow to jump to the call',
    class: 'Arrows: Derived → Base, Consumer → Dependency, DI → Service · right-click to expand · double-click to open · click an arrow to jump to the code'
  };
  const LEGEND_COLORS = {
    line: ['--vscode-editorLineNumber-foreground', '#858585'], purple: ['--vscode-charts-purple', '#c586c0'],
    orange: ['--vscode-charts-orange', '#d18616'], blue: ['--vscode-charts-blue', '#3794ff'],
    green: ['--vscode-charts-green', '#89d185'], muted: ['--vscode-descriptionForeground', '#9d9d9d']
  };

  function renderLegend() {
    if (!$('legend') || !$('hint')) return;
    $('legend').innerHTML = LEGEND[mode].map(([kind, style, color]) => {
      const c = cssVar(...LEGEND_COLORS[color]);
      return `<span class="legend"><i class="sw" style="border-top-style:${style};border-color:${c}"></i>${escapeHtml(KIND_TEXT[kind])}</span>`;
    }).join('');
    $('hint').textContent = HINT[mode];
  }

  // ---------- Status & details ----------
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

  function showNodeDetails(n) {
    const fn = n.data('fn');
    const guard = n.data('guard') || [];
    detailsEl.innerHTML =
      `<div><code>${escapeHtml(fn.signature)}</code></div>` +
      `<div class="muted">${escapeHtml(fn.containingType)}</div>` +
      `<div class="muted">${escapeHtml(fn.filePath)}:${fn.line}</div>` +
      (guard.length ? `<div>all calls require <code>${escapeHtml(guard.join(' && '))}</code></div>` : '') +
      `<div class="muted">${n.data('collapsed') ? 'not expanded yet'
        : mode === 'class' ? `${n.connectedEdges().length ? 'relations shown' : 'no relations'}`
        : `calls ${outgoingGroups(fn.id).length} function(s)`}</div>`;
    detailsEl.hidden = false;
  }

  function showGroupDetails(g) {
    const src = cy.getElementById(g.source).data('fn');
    const tgt = cy.getElementById(g.target).data('fn');
    const calls = g.calls
      .map(c =>
        `<div>${mode === 'class' ? (c.label ? `<code>${escapeHtml(c.label)}</code>` : '')
          : c.condition ? `when <code>${escapeHtml(c.condition)}</code>` : '<span class="muted">unconditional</span>'}` +
        ` <span class="muted">· ${escapeHtml(fileName(c.callFilePath))}:${c.callLine}</span></div>`)
      .join('');
    detailsEl.innerHTML =
      `<div><code>${escapeHtml(src.name)}</code> → <code>${escapeHtml(tgt.name)}</code>` +
      ` <span class="muted">(${escapeHtml(KIND_TEXT[g.edgeKind] || g.edgeKind)})</span></div>` + calls;
    detailsEl.hidden = false;
  }

  function highlightGroup(groupId) {
    cy.edges('.hl').removeClass('hl');
    if (groupId) cy.edges().filter(e => e.data('group') === groupId).addClass('hl');
  }

  function selectedFn() {
    const sel = cy.$('node.fn:selected');
    return sel.nonempty() ? sel[0] : null;
  }

  function updateButtons() {
    const n = selectedFn();
    btnExpand.disabled = btnExpand3.disabled = !n;
    btnReroot.disabled = !n || n.id() === rootId;
  }

  // ---------- Messages from extension ----------
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'reset':
        cy.elements().remove();
        groups.clear();
        loading.clear();
        autoFit = true;
        rootId = msg.root.id;
        mode = msg.mode || 'call';
        renderLegend();
        direction = msg.direction || direction;
        btnDir.textContent = `Direction: ${direction}`;
        addNode(msg.root, true);
        runLayout();
        detailsEl.hidden = true;
        updateButtons();
        setStatus('');
        break;

      case 'add':
        cy.batch(() => {
          for (const fn of msg.nodes) addNode(fn, false);
          for (const e of msg.edges) addCall(e);
          for (const id of msg.expanded) setCollapsed(id, false);
          new Set(msg.edges.map(e => e.source)).forEach(relabelOutgoing);
        });
        runLayout();
        break;

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

  function onGroupTap(groupId) {
    const g = groups.get(groupId);
    if (!g) return;
    highlightGroup(groupId);
    showGroupDetails(g);
    vscode.postMessage({ type: 'jumpToCall', edgeId: g.calls[0].id });
  }

  cy.on('tap', 'node.fn', evt => {
    highlightGroup(null);
    showNodeDetails(evt.target);
    setTimeout(updateButtons, 0);
  });
  cy.on('tap', 'node.cond', evt => onGroupTap(evt.target.data('group')));
  cy.on('tap', 'edge', evt => onGroupTap(evt.target.data('group')));
  cy.on('dbltap', 'node.fn', evt => vscode.postMessage({ type: 'jumpToNode', id: evt.target.id() }));
  cy.on('cxttap', 'node.fn', evt => {
    evt.target.select();
    expand(evt.target, 1);
  });
  cy.on('tap', evt => {
    if (evt.target === cy) {
      detailsEl.hidden = true;
      highlightGroup(null);
      setTimeout(updateButtons, 0);
    }
  });
  cy.on('select unselect', 'node', updateButtons);

  // Any manual pan/zoom stops auto-fitting so expanding does not yank the viewport away.
  cy.on('pan zoom', evt => {
    if (evt.originalEvent) autoFit = false;
  });
  $('cy').addEventListener('wheel', () => (autoFit = false), { passive: true });

  $('btn-fit').addEventListener('click', () => {
    autoFit = true;
    fitView();
  });
  btnDir.addEventListener('click', () => {
    direction = direction === 'TB' ? 'LR' : 'TB';
    btnDir.textContent = `Direction: ${direction}`;
    autoFit = true;
    runLayout();
  });
  btnExpand.addEventListener('click', () => expand(selectedFn(), 1));
  btnExpand3.addEventListener('click', () => expand(selectedFn(), 3));
  btnReroot.addEventListener('click', () => {
    const n = selectedFn();
    if (n) vscode.postMessage({ type: 'reroot', id: n.id() });
  });

  renderLegend();
  vscode.postMessage({ type: 'ready' });
})();
