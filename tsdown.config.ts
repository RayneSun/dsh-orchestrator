import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as {
  name: string
  dsh: { client: { inject: string[]; external?: string[] } }
}

const deepseekExternal = /^@deepseek-ai\//
// FullCalendar 官方 CSS 以字符串内联，沿用客户端现有 adoptStyles 注入机制。
const CSS_TEXT_PREFIX = '\0css-text:'
const cssText = {
  name: 'css-text',
  async resolveId(id: string, importer: string | undefined) {
    if (!id.endsWith('.css')) return null
    const resolved = await this.resolve(id, importer, { skipSelf: true })
    return resolved ? `${CSS_TEXT_PREFIX}${resolved.id}.js` : null
  },
  load(id: string) {
    if (!id.startsWith(CSS_TEXT_PREFIX)) return null
    const file = id.slice(CSS_TEXT_PREFIX.length, -3)
    return { code: `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`, moduleType: 'js' as const }
  },
}
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
  deps: { neverBundle: [deepseekExternal, /^node:/, 'zod'] },
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
    plugins: [cssText],
    // DSH Web 只注入 dsh.client.inject 中的包；Zod 必须内联进 closure。
    deps: {
      neverBundle: [...clientInject, /^react($|\/)/, /^react-dom($|\/)/],
      alwaysBundle: [/^zod($|\/)/, /^@fullcalendar\//, /^@full-ui\//, /^temporal-polyfill($|\/)/],
      onlyBundle: [/^zod($|\/)/, /^@fullcalendar\//, /^@full-ui\//, /^temporal-/],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
