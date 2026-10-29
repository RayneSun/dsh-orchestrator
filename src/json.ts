export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** DSH 工具输出要求无损 JSON；显式移除对象中的 undefined 字段。 */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as JsonValue
  }
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value !== 'object') return null
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = toJson(item)
  }
  return out
}
