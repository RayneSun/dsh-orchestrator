/**
 * 定时任务会话标记：绑定了活动定时任务的子会话，DSH 侧栏标题统一维护 ⏰ 前缀
 * （可辨、可搜索），看板通过快照里的 hasActiveSchedule 渲染 badge。
 * 标记本身不落库：宿主监听 schedule/changed 并启动时全量核对，即时推导。
 */

export const SCHEDULE_MARK_PREFIX = '⏰ '

/** 幂等维护标题前缀：marked 加前缀（先去掉旧前缀防重复），否则去除。 */
export function applyScheduleMark(title: string, marked: boolean): string {
  const clean = title.startsWith(SCHEDULE_MARK_PREFIX) ? title.slice(SCHEDULE_MARK_PREFIX.length) : title
  return marked ? `${SCHEDULE_MARK_PREFIX}${clean}` : clean
}

/** 宿主 schedule 服务的最小结构化接口（本地声明，不新增包导入）。 */
export interface ScheduleServiceLike {
  list(request: { sessionId: string }): Promise<unknown[]>
}

/** workspace/session-activity 瀑布的活动分组（与 dsh-schedule 上报同构）。 */
export interface SessionActivityGroup {
  kind: string
  items: Array<{ id: string; label: string }>
}
