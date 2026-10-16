import { cpSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'lib/vendor/dsh-computer-use-darwin')
mkdirSync(out, { recursive: true })
cpSync(resolve(root, 'vendor/dsh-computer-use-darwin'), out, { recursive: true })
