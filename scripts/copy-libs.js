// Copies the graph libraries into media/lib so the webview loads them locally (no CDN, works offline).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'media', 'lib');
const files = [
    'node_modules/cytoscape/dist/cytoscape.min.js',
    'node_modules/dagre/dist/dagre.min.js',
    'node_modules/cytoscape-dagre/cytoscape-dagre.js'
];

fs.mkdirSync(outDir, { recursive: true });
for (const rel of files) {
    const src = path.join(root, rel);
    fs.copyFileSync(src, path.join(outDir, path.basename(src)));
}
console.log(`Copied ${files.length} libraries to media/lib`);
