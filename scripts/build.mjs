import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmpDir = path.join(root, '.tmp_build');
const distDir = path.join(root, 'dist');

const entryPoints = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/index.ts',
  options: 'src/options/index.ts'
};

const excludedSegments = new Set(['node_modules', 'dist', '.git', 'tests', 'fixtures', 'docs', 'backups']);

console.log('[build] Starting bounded extension build');
console.log('[build] Entry points:');
for (const [name, rel] of Object.entries(entryPoints)) {
  console.log(`  - ${name}: ${rel}`);
}

await rm(tmpDir, { recursive: true, force: true });
await rm(distDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
await mkdir(distDir, { recursive: true });

execSync(`tsc -p ${path.join(root, 'tsconfig.json')} --outDir ${tmpDir}`, { stdio: 'inherit' });

await copyStaticFiles();

const outputFiles = [];
for (const [name, relEntry] of Object.entries(entryPoints)) {
  const outFile = `${name}.js`;
  const bundle = await bundleEntry(path.join(tmpDir, relEntry.replace(/\.ts$/, '.js')));
  await writeFile(path.join(distDir, outFile), bundle, 'utf8');
  outputFiles.push(outFile);
  console.log(`[build] Wrote ${outFile}`);
}

await patchHtmlAndManifest();
await rm(tmpDir, { recursive: true, force: true });

console.log('[build] Static files copied: manifest.json, popup.html, options.html, content.css');
console.log('[build] Output files:');
for (const file of outputFiles) {
  const info = await stat(path.join(distDir, file));
  console.log(`  - ${file} (${info.size} bytes)`);
}

async function copyStaticFiles() {
  const requiredPublicFiles = ['manifest.json', 'popup.html', 'options.html', 'content.css'];
  for (const file of requiredPublicFiles) {
    await cp(path.join(root, 'public', file), path.join(distDir, file));
  }
}

async function patchHtmlAndManifest() {
  const popupPath = path.join(distDir, 'popup.html');
  const optionsPath = path.join(distDir, 'options.html');
  const manifestPath = path.join(distDir, 'manifest.json');

  const popupHtml = (await readFile(popupPath, 'utf8')).replace('src/popup/index.js', 'popup.js');
  await writeFile(popupPath, popupHtml, 'utf8');

  const optionsHtml = (await readFile(optionsPath, 'utf8')).replace('src/options/index.js', 'options.js');
  await writeFile(optionsPath, optionsHtml, 'utf8');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.background.service_worker = 'background.js';
  for (const script of manifest.content_scripts ?? []) script.js = ['content.js'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function bundleEntry(entryAbsPath) {
  const modules = new Map();
  await visitModule(entryAbsPath, modules);

  const moduleBodies = [...modules.entries()]
    .map(([id, code]) => `${JSON.stringify(id)}: function(module, exports, require) {\n${code}\n}`)
    .join(',\n');

  return `(()=>{\nconst modules = {\n${moduleBodies}\n};\nconst cache = {};\nfunction require(id){\n  if(cache[id]) return cache[id].exports;\n  const factory = modules[id];\n  if(!factory) throw new Error('Module not found: '+id);\n  const module = { exports: {} };\n  cache[id] = module;\n  factory(module, module.exports, require);\n  return module.exports;\n}\nrequire(${JSON.stringify(normalizePath(entryAbsPath))});\n})();\n`;
}

async function visitModule(fileAbsPath, modules) {
  const normalized = normalizePath(fileAbsPath);
  if (modules.has(normalized)) return;
  ensureAllowedSource(normalized);

  modules.set(normalized, '');
  const source = await readFile(normalized, 'utf8');
  const deps = collectRelativeDeps(source, normalized);
  for (const dep of deps) await visitModule(dep, modules);

  const rewritten = source.replace(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g, (_m, spec) => {
    return `from '${normalizePath(resolveRelative(normalized, spec))}'`;
  }).replace(/import\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (_m, quote, spec) => {
    return `import(${quote}${normalizePath(resolveRelative(normalized, spec))}${quote})`;
  });

  const cjs = esmToCjs(rewritten);
  modules.set(normalized, cjs);
}

function collectRelativeDeps(source, fromAbsPath) {
  const deps = [];
  const importFrom = /^\s*import\s+[^'"\n]+\s+from\s+['"](\.{1,2}\/[^'"]+)['"];?/gm;
  const importBare = /^\s*import\s+['"](\.{1,2}\/[^'"]+)['"];?/gm;
  const exportFrom = /^\s*export\s+[^'"\n]+\s+from\s+['"](\.{1,2}\/[^'"]+)['"];?/gm;

  for (const regex of [importFrom, importBare, exportFrom]) {
    let match = regex.exec(source);
    while (match) {
      deps.push(resolveRelative(fromAbsPath, match[1]));
      match = regex.exec(source);
    }
  }
  return deps;
}

function resolveRelative(fromAbsPath, spec) {
  const base = path.resolve(path.dirname(fromAbsPath), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
  for (const c of candidates) {
    try {
      if (statSyncSafe(c)) return normalizePath(c);
    } catch {}
  }
  throw new Error(`Cannot resolve import ${spec} from ${fromAbsPath}`);
}

function statSyncSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureAllowedSource(absPath) {
  const rel = path.relative(tmpDir, absPath).split(path.sep);
  if (!rel[0] || rel[0] !== 'src') throw new Error(`Build only allows source files from src/: ${absPath}`);
  if (rel.some((segment) => excludedSegments.has(segment))) throw new Error(`Build hit excluded segment for ${absPath}`);
}

function esmToCjs(code) {
  const importStatements = [];
  code = code.replace(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm, (_m, spec, src) => {
    importStatements.push(`const { ${spec.replace(/\sas\s/g, ': ')} } = require('${src}');`);
    return '';
  });
  code = code.replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?$/gm, (_m, ns, src) => {
    importStatements.push(`const ${ns} = require('${src}');`);
    return '';
  });
  code = code.replace(/^\s*import\s+['"]([^'"]+)['"];?$/gm, (_m, src) => {
    importStatements.push(`require('${src}');`);
    return '';
  });

  const exports = [];
  code = code.replace(/export\s+async\s+function\s+(\w+)/g, (_m, name) => { exports.push(name); return `async function ${name}`; });
  code = code.replace(/export\s+function\s+(\w+)/g, (_m, name) => { exports.push(name); return `function ${name}`; });
  code = code.replace(/export\s+const\s+(\w+)/g, (_m, name) => { exports.push(name); return `const ${name}`; });
  code = code.replace(/export\s+let\s+(\w+)/g, (_m, name) => { exports.push(name); return `let ${name}`; });
  code = code.replace(/export\s+class\s+(\w+)/g, (_m, name) => { exports.push(name); return `class ${name}`; });
  code = code.replace(/^\s*export\s+\{([^}]+)\};?$/gm, (_m, spec) => {
    spec.split(',').forEach((part) => exports.push(part.trim().split(/\s+as\s+/)[0]));
    return '';
  });

  const exportLines = exports.map((name) => `exports.${name} = ${name};`).join('\n');
  return `${importStatements.join('\n')}\n${code}\n${exportLines}`;
}

function normalizePath(p) {
  return path.resolve(p).split(path.sep).join('/');
}
