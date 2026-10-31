/** Rebuild the pinned xterm source into both entrypoints; never hand-edit a
 * minified bundle. Afterwards run npx patch-package @xterm/xterm and npm ci. */
import { build } from 'esbuild'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
const root = path.resolve('node_modules/@xterm/xterm')
if (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '6.0.0') {
  throw new Error('Review the adapter and patch before changing the pinned xterm version')
}
for (const [format, file] of [['esm', 'xterm.mjs'], ['cjs', 'xterm.js']]) {
  const result = await build({
    stdin: { contents: "export { Terminal } from './browser/public/Terminal'", resolveDir: path.join(root, 'src'), loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format, minify: true, target: 'es2020', legalComments: 'eof',
    // Preserve Node's named ESM imports from the CommonJS entrypoint too.
    footer: format === 'cjs' ? { js: '0 && (module.exports = { Terminal });' } : undefined,
    alias: Object.fromEntries(['browser', 'common', 'vs'].map(p => [p, path.join(root, 'src', p)])),
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
  })
  writeFileSync(path.join(root, 'lib', file), result.outputFiles[0].contents)
  console.log(`${file}: ${result.outputFiles[0].contents.length} bytes`)
}
