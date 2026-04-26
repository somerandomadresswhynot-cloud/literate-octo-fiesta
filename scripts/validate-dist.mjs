import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist');

console.log('[validate] Checking dist manifest');
await access(path.join(dist, 'manifest.json'));
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));

const filesToCheck = new Set(['manifest.json', 'content.js']);
if (manifest.background?.service_worker) filesToCheck.add(manifest.background.service_worker);
if (manifest.action?.default_popup) filesToCheck.add(manifest.action.default_popup);
if (manifest.options_page) filesToCheck.add(manifest.options_page);

for (const cs of manifest.content_scripts ?? []) {
  for (const js of cs.js ?? []) filesToCheck.add(js);
  for (const css of cs.css ?? []) filesToCheck.add(css);
}

console.log('[validate] Checking manifest-referenced files:');
for (const file of filesToCheck) {
  console.log(`  - ${file}`);
  await access(path.join(dist, file));
}

const contentPath = path.join(dist, 'content.js');
const content = await readFile(contentPath, 'utf8');
const hasTopLevelImportExport = /^\s*(import|export)\s/m.test(content);
console.log(`[validate] dist/content.js top-level import/export: ${hasTopLevelImportExport ? 'FOUND' : 'none'}`);
if (hasTopLevelImportExport) {
  throw new Error('dist/content.js contains top-level import/export statements');
}

console.log('[validate] dist validation OK');
