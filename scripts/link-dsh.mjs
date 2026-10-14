import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_REPO
  ? resolve(process.env.DSH_REPO)
  : resolve(import.meta.dirname, '../../New project 2')

if (!existsSync(dsh)) {
  throw new Error(`DSH source repository not found: ${dsh}. Set DSH_REPO=/path/to/deepseek-harness and retry.`)
}

const links = {
  '@deepseek-ai/cordis': `${dsh}/vendor/cordis`,
  '@deepseek-ai/schemastery': `${dsh}/vendor/schemastery`,
  '@deepseek-ai/dsh-agent': `${dsh}/packages/core/agent`,
  '@deepseek-ai/dsh-tools': `${dsh}/packages/core/tools`,
  '@deepseek-ai/dsh-llm': `${dsh}/packages/llm/llm`,
  '@deepseek-ai/dsh-session': `${dsh}/packages/session/session`,
  '@deepseek-ai/dsh-session-persistence': `${dsh}/packages/session/session-persistence`,
  '@deepseek-ai/dsh-storage-domain': `${dsh}/packages/storage/storage-domain`,
  '@deepseek-ai/dsh-subagent': `${dsh}/packages/subagent/subagent`,
  '@deepseek-ai/dsh-typert-protocol': `${dsh}/packages/typert/protocol`,
  '@deepseek-ai/dsh-agent-preset-registry': `${dsh}/packages/preset/agent-preset-registry`,
  '@deepseek-ai/dsh-api-session-controller': `${dsh}/packages/api/session-controller`,
}
for (const [name, target] of Object.entries(links)) {
  if (!existsSync(target)) throw new Error(`linked DSH package does not exist: ${target}`)
  const link = resolve(root, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
}
