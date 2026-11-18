import { cp, mkdir, rm } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })
await mkdir('dist')

let commit = 'local'
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}
const buildId = `${commit} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

const common = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
}

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    // Native modules must stay in node_modules: bundled, `bindings` can't find their .node file.
    external: ['electron', 'koffi', 'loopback-capture', 'bindings', 'ws', 'bufferutil', 'utf-8-validate'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/main.ts'],
    outfile: 'dist/renderer.js',
    platform: 'browser',
    format: 'iife',
  }),
])

await cp('src/renderer/index.html', 'dist/index.html')
await cp('src/renderer/styles.css', 'dist/styles.css')
