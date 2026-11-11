// Patch only the four dashboard calls that support folder mutations. Preserve
// mapping positions, and update content hashes and webpack lazy references.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decode, encode } from '@jridgewell/sourcemap-codec';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'frontend-dist/js');
const names = await readdir(dir);
const dashboard = names.find(x => /^198\.[a-f0-9]{8}\.js$/.test(x));
const app = names.find(x => /^app\.[a-f0-9]{8}\.js$/.test(x));
if (!dashboard || !app) throw new Error('Dashboard or runtime bundle missing');
const read = name => readFile(resolve(dir, name), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 8);
const indexPath = resolve(root, 'frontend-dist/index.html');
let html = await readFile(indexPath, 'utf8');
async function remove(name) {
    const path = resolve(dir, name);
    if (dirname(path) !== dir) throw new Error('Unsafe asset path');
    await unlink(path);
}
async function saveBundle(oldName, stem, code, map) {
    const body = code.replace(/\r?\n\/\/# sourceMappingURL=.*?\s*$/, '');
    const name = `${stem}.${hash(body)}.js`;
    map.file = `js/${name}`;
    await writeFile(resolve(dir, name), `${body}\n//# sourceMappingURL=${name}.map\n`);
    await writeFile(resolve(dir, `${name}.map`), JSON.stringify(map));
    if (name !== oldName) { await remove(oldName); await remove(`${oldName}.map`); }
    return name;
}
const helper = (await readFile(resolve(root, 'frontend-patches/folderMutations.js'), 'utf8')).replace(/^\uFEFF/, '');
const helperName = `folder-mutations.${hash(helper)}.js`;
await writeFile(resolve(dir, helperName), helper);
const previousHelper = html.match(/folder-mutations\.[a-f0-9]{8}\.js/)?.[0];
if (previousHelper) {
    if (previousHelper !== helperName) { html = html.replace(previousHelper, helperName); await remove(previousHelper); }
} else {
    const appTag = `<script defer="defer" src="/js/${app}"></script>`;
    if (!html.includes(appTag)) throw new Error('Expected app script tag not found');
    html = html.replace(appTag, `<script defer="defer" src="/js/${helperName}"></script>${appTag}`);
}
let code = await read(dashboard);
const pattern = /\(0,E\.A\)\((?=`\/api\/manage\/(?:move|delete)\/[^`]*\?folder=)/g;
const matches = [...code.matchAll(pattern)];
if (matches.length === 4) {
    const map = JSON.parse(await read(`${dashboard}.map`));
    const mappings = decode(map.mappings);
    const original = code;
    const call = ' globalThis.__imgbedFolderMutation(E.A,';
    for (const match of matches.reverse()) {
        const start = match.index, end = start + match[0].length;
        const line = original.slice(0, start).split('\n').length - 1;
        const column = start - original.lastIndexOf('\n', start) - 1;
        const span = end - start, delta = call.length - span;
        mappings[line] = mappings[line].filter(seg => seg[0] < column || seg[0] >= column + span)
            .map(seg => seg[0] >= column + span ? [seg[0] + delta, ...seg.slice(1)] : seg);
        code = code.slice(0, start) + call + code.slice(end);
    }
    map.mappings = encode(mappings);
    const newDashboard = await saveBundle(dashboard, '198', code, map);
    const oldHash = dashboard.split('.')[1], newHash = newDashboard.split('.')[1];
    const runtime = await read(app);
    const needle = `198:"${oldHash}"`;
    if (!runtime.includes(needle) || !html.includes(app)) throw new Error('Dashboard lazy reference missing');
    const runtimeMap = JSON.parse(await read(`${app}.map`));
    runtimeMap.sourcesContent = runtimeMap.sourcesContent.map(value => value?.replaceAll(oldHash, newHash));
    const newApp = await saveBundle(app, 'app', runtime.replace(needle, `198:"${newHash}"`), runtimeMap);
    html = html.replaceAll(app, newApp);
    console.log(`Updated ${newDashboard}, ${newApp}, ${helperName}`);
} else if (matches.length !== 0 || (code.match(/globalThis\.__imgbedFolderMutation\(E\.A,/g) || []).length !== 4) {
    throw new Error('Dashboard callsite layout changed; inspect before patching');
} else {
    console.log('Dashboard folder callsites are up to date');
}
await writeFile(indexPath, html);
