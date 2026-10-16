import { describe, expect, it } from 'vitest'
import { isWorkerToolForbidden, workerForbiddenPatterns } from '../src/worker-policy.ts'

describe('统一 Worker 权限', () => {
  it('禁止再派生或编排子 Agent', () => {
    for (const name of ['subagent', 'subagent_spawn', 'subagent_fork', 'workflow', 'ralph', 'interrupt_agent', 'send_message', 'list_subagent_models']) {
      expect(isWorkerToolForbidden(name)).toContain(name)
    }
  })

  it('禁止调用 Lead 的 orchestrator 工具（含未来新增）', () => {
    for (const name of ['orchestrator_dispatch', 'orchestrator_list', 'orchestrator_get']) {
      expect(isWorkerToolForbidden(name)).toContain('orchestrator')
    }
  })

  it('禁止 Worker 直接向用户提问，要求改走 input_required + question', () => {
    for (const name of ['ask_user_question', 'ask_user']) {
      expect(isWorkerToolForbidden(name)).toContain('task_update')
    }
  })

  it('放行执行类、浏览器、MCP 和用户安装的工具', () => {
    for (const name of [
      'read', 'write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'run_code',
      'glob', 'grep', 'web_search', 'web_fetch', 'task_update',
      'job_list', 'job_output', 'job_kill', 'todo_write', 'goal_create',
      'browser_session', 'browser_page', 'browser_interact',
      'mcp__writer__update', 'tool:read',
    ]) {
      expect(isWorkerToolForbidden(name)).toBeUndefined()
    }
  })

  it('导出的禁用模式表不包含 job 等普通执行工具', () => {
    expect(workerForbiddenPatterns).not.toContain('job')
    expect(workerForbiddenPatterns).not.toContain('job_kill')
  })
})
