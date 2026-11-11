export interface ModelAttribution {
  requestedModel: string
  responseModel?: string
}

interface ModelTaskFields {
  requestedModel?: string
  responseModel?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** DSH 持久化的 assistant source 同时记录请求模型与上游响应模型。 */
export function readModelAttribution(message: unknown): ModelAttribution | undefined {
  const source = (message as {
    source?: {
      kind?: unknown
      model?: unknown
      replayState?: { response?: { responseModel?: unknown } }
    }
  } | null | undefined)?.source
  if (source?.kind !== 'model') return undefined
  const requestedModel = nonEmpty(source.model)
  if (!requestedModel) return undefined
  const responseModel = nonEmpty(source.replayState?.response?.responseModel)
  return { requestedModel, ...responseModel ? { responseModel } : {} }
}

/** 将本轮最新模型元数据并入任务；没有新响应时保持原记录。 */
export function withModelAttribution<T extends ModelTaskFields>(task: T, attribution: ModelAttribution | undefined): T {
  if (!attribution) return task
  return {
    ...task,
    requestedModel: attribution.requestedModel,
    responseModel: attribution.responseModel,
  }
}

/** 看板展示：路由到不同模型时显示“传入-返回”，否则以传入模型为准。 */
export function modelDisplayName(task: ModelTaskFields): string | undefined {
  const requested = nonEmpty(task.requestedModel)
  if (!requested) return undefined
  const response = nonEmpty(task.responseModel)
  return response && response !== requested ? `${requested}-${response}` : requested
}
