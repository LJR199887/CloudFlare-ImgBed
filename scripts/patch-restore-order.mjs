// The repository ships frontend-dist without the Vue build sources. Rebuild only
// RestoreProcessor from its recovered source, keeping unrelated webpack modules
// intact. Regenerate mappings and content hashes so browsers load the new code.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';
import { decode, encode } from '@jridgewell/sourcemap-codec';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'frontend-dist');
const jsDir = resolve(dist, 'js');
const names = await readdir(jsDir);
const chunkName = names.find(name => /^381\.[a-f0-9]{8}\.js$/.test(name));
const appName = names.find(name => /^app\.[a-f0-9]{8}\.js$/.test(name));
if (!chunkName || !appName) throw new Error('Expected webpack bundles not found');
const source = await readFile(resolve(root, 'frontend-patches/restoreProcessor.js'), 'utf8');
const transformed = source.replace(/^import .*;\r?\n/gm, '')
    .replace('class RestoreProcessor', 'class cu')
    .replace(/\bBatchOperationError\b/g, 'su')
    .replace(/\bfetchWithAuth\(/g, '(0,Pe.A)(')
    .replace(/^export default RestoreProcessor;\r?\n?/m, '');
const build = await transform(transformed, {
    sourcefile: 'frontend-patches/restoreProcessor.js', sourcemap: 'external',
    minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, target: 'es2022',
});
const replacement = build.code.trim();
const bundle = await readFile(resolve(jsDir, chunkName), 'utf8');
const start = bundle.indexOf('class cu{');
const end = bundle.indexOf('var uu=cu;', start);
if (start < 0 || end < 0 || bundle.slice(start, end).includes('\n') || replacement.includes('\n')) {
    throw new Error('Unexpected webpack layout; inspect bundle before patching');
}
const oldFinish = 'this.$message.success(this.$t("sysStatus.restoreSuccess",{files:n.restoredFiles,settings:n.restoredSettings})),await new Promise(t=>setTimeout(t,500)),await this.rebuildIndex()';
const newFinish = 'n.failedFiles||n.failedSettings?this.$message.warning(this.$t("sysStatus.restoreFailed")+" ("+n.failedFiles+" files, "+n.failedSettings+" settings)"):this.$message.success(this.$t("sysStatus.restoreSuccess",{files:n.restoredFiles,settings:n.restoredSettings})),n.reauthenticationRequired&&await this.$router.replace({name:"adminLogin"})';
const finishStart = bundle.indexOf(oldFinish, end);
if (finishStart < 0 && !bundle.includes(newFinish)) throw new Error('Restore completion handler changed; inspect before patching');
if (bundle.slice(start, end) === replacement && finishStart < 0) {
    console.log('RestoreProcessor bundle is up to date');
    process.exit(0);
}
let patched = bundle.slice(0, start) + replacement + bundle.slice(end);
const map = JSON.parse(await readFile(resolve(jsDir, `${chunkName}.map`), 'utf8'));
const localMap = JSON.parse(build.map);
const mappings = decode(map.mappings);
const line = bundle.slice(0, start).split('\n').length - 1;
const lineStart = bundle.lastIndexOf('\n', start) + 1;
const startColumn = start - lineStart, endColumn = end - lineStart;
const sourceOffset = map.sources.length;
const nameOffset = map.names.length;
const injected = decode(localMap.mappings)[0].map(segment => {
    const next = [...segment];
    next[0] += startColumn;
    if (next.length > 1) next[1] += sourceOffset;
    if (next.length > 4) next[4] += nameOffset;
    return next;
});
map.sources.push(...localMap.sources);
map.sourcesContent.push(...localMap.sourcesContent);
map.names.push(...localMap.names);
const shift = replacement.length - (end - start);
mappings[line] = [
    ...mappings[line].filter(segment => segment[0] < startColumn),
    [startColumn], ...injected,
    ...mappings[line].filter(segment => segment[0] >= endColumn).map(segment => [segment[0] + shift, ...segment.slice(1)]),
];
if (finishStart >= 0) {
    const offset = finishStart + shift;
    const finishLine = patched.slice(0, offset).split('\n').length - 1;
    const col = offset - patched.lastIndexOf('\n', offset) - 1;
    const delta = newFinish.length - oldFinish.length;
    mappings[finishLine] = [
        ...mappings[finishLine].filter(segment => segment[0] < col), [col],
        ...mappings[finishLine].filter(segment => segment[0] >= col + oldFinish.length).map(segment => [segment[0] + delta, ...segment.slice(1)]),
    ];
    patched = patched.slice(0, offset) + newFinish + patched.slice(offset + oldFinish.length);
}
map.mappings = encode(mappings);

function bodyOf(code) { return code.replace(/\r?\n\/\/# sourceMappingURL=.*?\s*$/, ''); }
function hash(code) { return createHash('sha256').update(code).digest('hex').slice(0, 8); }
async function saveBundle(oldName, stem, code, sourceMap) {
    const body = bodyOf(code);
    const newName = `${stem}.${hash(body)}.js`;
    sourceMap.file = `js/${newName}`;
    await writeFile(resolve(jsDir, newName), `${body}\n//# sourceMappingURL=${newName}.map\n`);
    await writeFile(resolve(jsDir, `${newName}.map`), JSON.stringify(sourceMap));
    if (oldName !== newName) {
        // Fixed, non-recursive removals inside the verified frontend asset folder.
        for (const name of [oldName, `${oldName}.map`]) {
            const path = resolve(jsDir, name);
            if (dirname(path) !== jsDir) throw new Error('Unsafe asset path');
            await unlink(path);
        }
    }
    return newName;
}
const newChunk = await saveBundle(chunkName, '381', patched, map);
const oldHash = chunkName.split('.')[1], newHash = newChunk.split('.')[1];
const app = await readFile(resolve(jsDir, appName), 'utf8');
const needle = `381:"${oldHash}"`;
if (!app.includes(needle)) throw new Error('Chunk hash not found in runtime');
const appMap = JSON.parse(await readFile(resolve(jsDir, `${appName}.map`), 'utf8'));
// Hash widths are unchanged; the runtime's generated mapping offsets stay valid.
appMap.sourcesContent = appMap.sourcesContent.map(text => text?.replaceAll(oldHash, newHash));
const newApp = await saveBundle(appName, 'app', app.replace(needle, `381:"${newHash}"`), appMap);
const indexPath = resolve(dist, 'index.html');
const index = await readFile(indexPath, 'utf8');
if (!index.includes(appName)) throw new Error('Runtime reference missing in index.html');
await writeFile(indexPath, index.replaceAll(appName, newApp));
console.log(`Updated ${newChunk}, ${newApp} and index.html`);
