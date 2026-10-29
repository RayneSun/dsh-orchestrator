/**
 * 定时任务会话标记：绑定了活动定时任务的子会话，看板通过快照里的
 * hasActiveSchedule 渲染 badge（DSH 侧栏标题不加任何图标前缀）。
 * 标记本身不落库：宿主监听 schedule/changed 并启动时全量核对，即时推导。
 */

/** 宿主 schedule 服务的最小结构化接口（本地声明，不新增包导入）。 */
export interface ScheduleServiceLike {
  list(request: { sessionId: string }): Promise<unknown[]>
}

/** workspace/session-activity 瀑布的活动分组（与 dsh-schedule 上报同构）。 */
export interface SessionActivityGroup {
  kind: string
  items: Array<{ id: string; label: string }>
}
