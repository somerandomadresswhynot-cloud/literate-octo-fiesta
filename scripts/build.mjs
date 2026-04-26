import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmpDir = path.join(root, '.tmp_build');
const distDir = path.join(root, 'dist');

await rm(tmpDir, { recursive: true, force: true });
execSync(`tsc -p ${path.join(root, 'tsconfig.json')} --outDir ${tmpDir}`, { stdio: 'inherit' });

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(path.join(root, 'public'), distDir, { recursive: true });

const moduleCache = new Map();

function normalize(p) {
  return p.split(path.sep).join('/');
}

async function loadModule(filePath) {
  const normalized = normalize(path.resolve(filePath));
  if (moduleCache.has(normalized)) return;

  let code = await readFile(normalized, 'utf8');
  const imports = [];

  code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+['"](.+)['"];?$/gm, (_, spec, src) => {
    imports.push({ spec: spec.trim(), src });
    return '';
  });

  code = code.replace(/^import\s+['"](.+)['"];?$/gm, (_, src) => {
    imports.push({ spec: '', src });
    return '';
  });

  for (const imp of imports) {
    const targetPath = resolveImport(normalized, imp.src);
    await loadModule(targetPath);
  }

  const exportNames = [];
  code = code.replace(/export\s+async\s+function\s+(\w+)/g, (_, name) => { exportNames.push(name); return `async function ${name}`; });
  code = code.replace(/export\s+function\s+(\w+)/g, (_, name) => { exportNames.push(name); return `function ${name}`; });
  code = code.replace(/export\s+const\s+(\w+)/g, (_, name) => { exportNames.push(name); return `const ${name}`; });
  code = code.replace(/export\s+let\s+(\w+)/g, (_, name) => { exportNames.push(name); return `let ${name}`; });
  code = code.replace(/export\s+class\s+(\w+)/g, (_, name) => { exportNames.push(name); return `class ${name}`; });
  code = code.replace(/^export\s+\{[^}]*\};?$/gm, '');

  const importLines = imports.map((imp) => {
    if (!imp.spec) return `require('${normalize(path.resolve(resolveImport(normalized, imp.src)))}');`;
    const destructured = imp.spec.replace(/\s+as\s+/g, ': ');
    return `const { ${destructured} } = require('${normalize(path.resolve(resolveImport(normalized, imp.src)))}');`;
  }).join('\n');

  const exportLines = exportNames.map((name) => `exports.${name} = ${name};`).join('\n');
  const wrapped = `${importLines}\n${code}\n${exportLines}`;
  moduleCache.set(normalized, wrapped);
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) throw new Error(`Only relative imports are supported: ${spec}`);
  return path.resolve(path.dirname(fromFile), spec);
}

async function bundleEntry(entryPath, outFileName) {
  moduleCache.clear();
  const fullEntry = path.join(tmpDir, entryPath);
  await loadModule(fullEntry);

  const modulesCode = Array.from(moduleCache.entries())
    .map(([id, body]) => `'${id}': function(module, exports, require) {\n${body}\n}`)
    .join(',\n');

  const bundle = `(()=>{\nconst modules = {\n${modulesCode}\n};\nconst cache = {};\nfunction require(id){\n if(cache[id]) return cache[id].exports;\n if(!modules[id]) throw new Error('Module not found: '+id);\n const module = { exports: {} };\n cache[id]=module;\n modules[id](module, module.exports, require);\n return module.exports;\n}\nrequire('${normalize(path.resolve(fullEntry))}');\n})();\n`;

  await writeFile(path.join(distDir, outFileName), bundle);
}

await bundleEntry('src/background/index.js', 'background.js');
await bundleEntry('src/content/index.js', 'content.js');
await bundleEntry('src/popup/index.js', 'popup.js');
await bundleEntry('src/options/index.js', 'options.js');

const popupHtml = (await readFile(path.join(distDir, 'popup.html'), 'utf8')).replace('src/popup/index.js', 'popup.js');
await writeFile(path.join(distDir, 'popup.html'), popupHtml);
const optionsHtml = (await readFile(path.join(distDir, 'options.html'), 'utf8')).replace('src/options/index.js', 'options.js');
await writeFile(path.join(distDir, 'options.html'), optionsHtml);

const manifestPath = path.join(distDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.background.service_worker = 'background.js';
for (const script of manifest.content_scripts ?? []) {
  script.js = ['content.js'];
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

await rm(tmpDir, { recursive: true, force: true });
