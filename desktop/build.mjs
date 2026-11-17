import { cp, mkdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })
await mkdir('dist')

const common = { bundle: true, sourcemap: true, target: 'es2022', tsconfig: 'tsconfig.json', logLevel: 'info' }

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'koffi', 'ws', 'bufferutil', 'utf-8-validate'],
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
