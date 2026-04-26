import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const dist = 'dist';
const contentPath = path.join(dist, 'content.js');
const content = await readFile(contentPath, 'utf8');

if (/^\s*import\s/m.test(content) || /^\s*export\s/m.test(content)) {
  throw new Error('dist/content.js contains top-level import/export statements');
}

const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));

const filesToCheck = [];
if (manifest.background?.service_worker) filesToCheck.push(manifest.background.service_worker);
for (const cs of manifest.content_scripts ?? []) {
  for (const js of cs.js ?? []) filesToCheck.push(js);
  for (const css of cs.css ?? []) filesToCheck.push(css);
}
if (manifest.action?.default_popup) filesToCheck.push(manifest.action.default_popup);
if (manifest.options_page) filesToCheck.push(manifest.options_page);

for (const file of filesToCheck) {
  await access(path.join(dist, file));
}

console.log('dist validation OK');
