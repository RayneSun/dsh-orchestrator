# TODO

## 自进化技能库（方案已确认方向，待实施）

参考 dsh-ciri 的 SkillProvider 模式（`/Users/lixuchuan/Documents/deepseek-harness/development/dsh-ciri`，只读参考、不改动它）。

1. **技能库位置**：主工作区 `skills/`（与 `.dsh-meow` 记忆库同层），落盘即保存，无 git。结构：`skills/<名称>/SKILL.md`（frontmatter: name/description/whenToUse + 何时用/怎么用）+ 可选 `scripts/`（复杂步骤沉淀为可执行脚本，SKILL.md 只教调用）+ 根放 `README.md` 说明格式。
2. **发现机制**（新模块 `src/skills.ts`）：服务激活时 `ctx.inject(['skills'])` 注册 SkillProvider（rank 300 与 CUSTOM_RANK 一致），扫描 `skills/*/SKILL.md` 解析 frontmatter；`fs.watch` 防抖 500ms invalidate，新技能落盘即生效；skills 服务缺失时降级无操作；启动幂等建目录 + 放 README.md（只补缺不覆盖）。
3. **Worker 访问**：Worker 文件作用域在子工作区，复用 `ensureSharedMemoryLink()` 同款为每个 Worker 子工作区建 `skills` 符号链接（win32 用 junction）指向主工作区 `skills/`。
4. **工具面**：Worker 预设已有 `tool-skill`；Lead 预设补挂 `tool-skill`。
5. **自进化协议（prompt）**：WORKER_PROMPT 加"技能沉淀"节——流程第二次出现或一次任务多步才走通的复杂操作，收尾时沉淀为技能；代码落 `scripts/` 不抄进文档；一次性的不沉淀，结论/事实仍写 memory 不双写。LEAD_PROMPT 加一句：用户说"以后都这样处理"时派发 Worker 沉淀技能。
6. **种子技能**：不带，只放 README.md。
7. **测试**：frontmatter 解析/扫描/provider list-get/watch 降级单测；skills 链接复用 memory link 测试模式；装包实测 Worker 沉淀技能后 Lead 新会话可调用。
