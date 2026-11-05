/**
 * Orchestrator 定制的 genui skill：用 runtime skill 覆盖 dsh-genui 原版（runtime 250 < provider 600）。
 * 正文在 genui-card-skill.md——基于原版 SKILL.md 定制：输出通道固定为 task_update.report.card，
 * 保留展示组件/范例，清除交互组件、测验页与验证引导。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GENUI_CARD_SKILL_DESCRIPTION
  = 'dsh-ui 卡片组件规范：结果含结构化数据（对比表、指标、步骤/时间线）时，把展示卡片 JSON 通过 task_update 的 report.card提交给用户。'

function loadSkillContent(): string {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'genui-card-skill.md'), 'utf8')
  } catch {
    return ''
  }
}

export const GENUI_CARD_SKILL_CONTENT = loadSkillContent()
