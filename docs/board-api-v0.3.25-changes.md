# v0.3.25 接口差异

基线：**v0.3.24**。本版只升级个人记忆插件依赖，任务看板 snapshot、RPC、存储结构和 Worker 工具协议均无变化。

## 依赖与升级

- `@cmjt/dsh-personal-memory` 从 `0.4.6` 升级至 `0.4.9`，依赖仍固定版本并随 orchestrator 自动安装。
- 本版没有看板接口或存储迁移要求；既有 v0.3.19 及更早版本升级边界保持不变。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.25 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.25.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
