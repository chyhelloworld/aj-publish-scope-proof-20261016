import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

export async function buildGitWriter(output) {
  const target = path.join(output, 'git-writer');
  await fs.mkdir(target, { recursive: true });
  for (const file of ['index.html', 'style.css'])
    await fs.copyFile(path.join('git-writer', file), path.join(target, file));
  await fs.cp('git-writer/fixtures', path.join(target, 'fixtures'), { recursive: true });
  const result = await build({
    entryPoints: ['git-writer/app.js'],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    outfile: path.join(target, 'app.js'),
    metafile: true,
    legalComments: 'eof',
  });
  for (const input of Object.keys(result.metafile.inputs))
    if (!input.startsWith('node_modules/') && !input.startsWith('git-writer/'))
      throw Error('Unexpected private source in writer bundle');
  console.log(
    JSON.stringify({
      writerBundleBuilt: true,
      bytes: (await fs.stat(path.join(target, 'app.js'))).size,
      privateSourceImports: 0,
    }),
  );
}
