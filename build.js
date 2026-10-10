import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/drive-ui.js'],
  outfile: 'dist/cave.js',
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  define: {
    global: 'globalThis',
    GOOGLE_CLIENT_ID: JSON.stringify(process.env.GOOGLE_CLIENT_ID || '')
  }
});
const html = (await readFile('index.html', 'utf8')).replace('./src/drive-ui.js', './cave.js');
await writeFile('dist/index.html', html);
await copyFile('manifest.json', 'dist/manifest.json');
const bundle = await readFile('dist/cave.js');
const hash = createHash('sha256').update(html).update(bundle)
  .update(await readFile('manifest.json')).update(await readFile('sw.js')).digest('hex').slice(0, 12);
await writeFile('dist/sw.js', (await readFile('sw.js', 'utf8')).replace('__BUILD_HASH__', hash));
