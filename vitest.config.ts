import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 客户端设置卡片引用的两个前端运行时 external 包（dsh.client.external）不在 node_modules，
// 测试环境用桩替代；行为断言见 delivery-toggles.spec.ts（纯函数）与 client-mount.spec.ts。
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/stubs/dsh-client-ui-primitives.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-store': fileURLToPath(new URL('./tests/stubs/dsh-client-store.ts', import.meta.url)),
    },
  },
})
