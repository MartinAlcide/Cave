import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Exercise the bundled connector, as in the browser. RxDB 17.6.0's published
// ESM signaling entry has an extensionless import unsupported by native Node.
const files = (await readdir('test')).filter(file => file.endsWith('.test.js'));
await build({ entryPoints: files.map(file => `test/${file}`), outdir: '.test-build',
  bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' } });
const child = spawn(process.execPath, ['--test', ...files.map(file => `.test-build/${file.replace(/\.js$/, '.cjs')}`)],
  { stdio: 'inherit' });
const [code] = await once(child, 'exit');
process.exitCode = code ?? 1;
