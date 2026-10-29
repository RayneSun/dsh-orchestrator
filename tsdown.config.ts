import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as {
  name: string
  dsh: { client: { inject: string[]; external?: string[] } }
}

const deepseekExternal = /^@deepseek-ai\//
// inject（cordis 服务包）与 external（前端 ModuleLoader 运行时模块表）都不内联进 client bundle。
const clientInject = new Set<string>([...pkg.dsh.client.inject, ...pkg.dsh.client.external ?? []])
const esm = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: false,
  splitting: false,
  outputOptions: { entryFileNames: '[name].js' },
  deps: { neverBundle: [deepseekExternal, /^node:/, 'zod', 'meow-memory'] },
}

export default defineConfig([
  {
    name: `${pkg.name}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    ...esm,
  },
  {
    name: `${pkg.name}/typert-host`,
    entry: { 'typert.host': 'src/typert-host.ts' },
    outDir: 'lib',
    ...esm,
  },
  {
    name: `${pkg.name}/remote-client`,
    entry: { 'typert.remote-client': 'src/remote.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    outputOptions: { entryFileNames: '[name].js' },
    deps: { neverBundle: [deepseekExternal] },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    // DSH Web 只注入 dsh.client.inject 中的包；Zod 必须内联进 closure。
    deps: { neverBundle: [...clientInject], alwaysBundle: [/^zod($|\/)/] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
