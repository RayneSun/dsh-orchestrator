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

const client = read('lib/client.js').trimStart()
if (!client.startsWith('window.__ModuleLoader__.load({')) fail('client artifact is not a ModuleLoader closure')
if (!client.includes('exports.apply = apply')) fail('client closure does not export apply')
if (!client.includes('require("react")') && !client.includes("require('react')")) fail('client must receive react from ModuleLoader')

const host = read('lib/typert.host.js')
if (!host.includes('face: "host"') && !host.includes("face: 'host'")) fail('host typert face missing')
const remote = read('lib/typert.remote-client.js')
if (!remote.includes('@may/dsh-orchestrator#orchestrator/snapshot')) fail('strict remote descriptor id missing')

const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
}))
const packed = new Set((report?.files ?? []).map(file => file.path))
for (const required of [
  'package.json',
  'cordis.patch.yml',
  'README.zh.md',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
]) {
  if (!packed.has(required)) fail(`npm pack output omits ${required}`)
}
for (const forbidden of packed) {
  if (forbidden.startsWith('src/') || forbidden.startsWith('tests/') || forbidden.startsWith('node_modules/')) {
    fail(`npm pack output leaks development path ${forbidden}`)
  }
}

console.log(`packaging ok: ${packed.size} files`)
