// 测试桩：前端 ModuleLoader 运行时提供的 external 包。
export function createSnapshotStore<T>(initial: T) {
  let value = initial
  return {
    getSnapshot: () => value,
    set(next: T) { value = next },
    subscribe: () => () => undefined,
  }
}
