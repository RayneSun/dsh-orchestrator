import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function fail(message) {
  throw new Error(message)
}

function read(relative) {
  const path = join(root, relative)
  if (!existsSync(path)) fail(`missing packaged build artifact: ${relative}`)
  return readFileSync(path, 'utf8')
}

const requiredExports = [
  ['.', './lib/index.js'],
  ['./client', './lib/client.js'],
  ['./typert', './lib/typert.host.js'],
  ['./remote', './lib/typert.remote-client.js'],
]
for (const [key, expected] of requiredExports) {
  const actual = pkg.exports?.[key]
  if (actual !== expected) fail(`exports[${key}] must point to ${expected}, got ${String(actual)}`)
  read(expected.replace(/^\.\//, ''))
}

for (const forbiddenDependency of [
  '@deepseek-ai/dsh-tools',
  '@milkuovo/dsh-computer-use',
  '@wxg-prc-cpg/browser-skill-dsh-plugin',
  '@zhengjunyao/dsh-qqmail',
]) {
  if (pkg.dependencies?.[forbiddenDependency]) {
    fail(`removed or host-owned dependency is still declared: ${forbiddenDependency}`)
  }
}
if (pkg.dependencies?.['@changfenhuang/dsh-genui'] !== '0.15.0') {
  fail('@changfenhuang/dsh-genui must be an ordinary pinned dependency so the bundle installs it')
}

const client = read('lib/client.js').trimStart()
if (!client.startsWith('window.__ModuleLoader__.load({')) fail('client artifact is not a ModuleLoader closure')
const clientId = client.match(/^window\.__ModuleLoader__\.load\(\{\s*id:\s*(["'])([^"']+)\1\s*,/)?.[2]
if (clientId !== pkg.name) fail(`client module id must be ${pkg.name}, got ${String(clientId)}`)
if (!client.includes('exports.apply = apply')) fail('client closure does not export apply')
if (!client.includes('require("react")') && !client.includes("require('react')")) fail('client must receive react from ModuleLoader')

const { TYPERT: host } = await import(new URL('../lib/typert.host.js', import.meta.url))
const { TYPERT_REMOTE: remote } = await import(new URL('../lib/typert.remote-client.js', import.meta.url))
if (host?.face !== 'host') fail('host typert face missing')
const expectedIds = ['snapshot', 'setScheduleStatus', 'answerTaskQuestions']
  .map(method => `${pkg.name}#orchestrator/${method}`).sort()
for (const [label, manifest, descriptors] of [
  ['host', host, host?.invocations],
  ['remote', remote, remote?.descriptors],
]) {
  if (manifest?.package !== pkg.name) fail(`${label} typert package must be ${pkg.name}, got ${String(manifest?.package)}`)
  const ids = descriptors?.map(descriptor => descriptor.id).sort()
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) fail(`${label} strict remote descriptor ids must be ${expectedIds.join(', ')}`)
}

const bundleRows = [...read('cordis.patch.yml').matchAll(/^\s*- id: ([^\s]+)\r?\n\s+name: (["'])([^"'\r\n]+)\2[ \t]*$/gm)]
for (const [id, expected] of [
  ['may-dsh-orchestrator', pkg.name],
  ['dsh-personal-memory', '@cmjt/dsh-personal-memory'],
  ['dsh-genui', '@changfenhuang/dsh-genui'],
]) {
  const rows = bundleRows.filter(row => row[1] === id)
  if (rows.length !== 1 || rows[0][3] !== expected) fail(`bundle row ${id} must reference ${expected} exactly once`)
}

const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
}))
const packed = new Set((report?.files ?? []).map(file => file.path))
for (const required of [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'genui-card-skill.md',
  'docs/vendor/fullcalendar/LICENSE.md',
  'docs/vendor/temporal-polyfill/LICENSE',
]) {
  if (!packed.has(required)) fail(`npm pack output omits ${required}`)
}
for (const forbidden of packed) {
  if (forbidden.endsWith('.map')) fail(`npm pack output leaks a source map: ${forbidden}`)
  if (forbidden.startsWith('lib/vendor/')) fail(`npm pack output contains removed vendored dependency: ${forbidden}`)
  if (forbidden.startsWith('src/') || forbidden.startsWith('tests/') || forbidden.startsWith('node_modules/')) {
    fail(`npm pack output leaks development path ${forbidden}`)
  }
}

for (const file of packed) {
  if (file.endsWith('.js') || file === 'cordis.patch.yml') {
    const content = read(file)
    if (content.includes('/Users/') || content.includes('New project 2')) {
      fail(`packaged file ${file} contains a local development path`)
    }
  }
}

console.log(`packaging ok: ${packed.size} files`)
