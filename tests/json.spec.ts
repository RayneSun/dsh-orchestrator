import { describe, expect, it } from 'vitest'
import { toJson } from '../src/json.ts'

describe('toJson', () => {
  it('removes undefined object fields without changing null values', () => {
    expect(toJson({ a: 1, b: undefined, c: null, nested: { d: undefined, e: 'ok' } }))
      .toEqual({ a: 1, c: null, nested: { e: 'ok' } })
  })

  it('preserves dense arrays recursively', () => {
    expect(toJson([1, undefined, { a: undefined, b: true }])).toEqual([1, null, { b: true }])
  })
})
