import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeQuestions, validateAnswers } from '../src/questions.ts'
import { mediaResponse, resolveMedia } from '../src/question-preview.ts'

describe('多媒体提问协议', () => {
  it('问题主体多图与选项预览共存，答案以选项 ID 传输', () => {
    const [question] = normalizeQuestions([{ question: '风格可行吗？', media: [
      { kind: 'image', source: 'images/a.png' }, { kind: 'image', source: 'images/b.png' },
    ], options: [{ label: '可行', preview: { kind: 'image', source: 'images/a.png' } }, { label: '不可行' }] }])
    expect(question).toMatchObject({ id: 'q1', options: [{ id: 'o1' }, { id: 'o2' }] })
    expect(question.media).toHaveLength(2)
    expect(validateAnswers([question], [{ id: 'q1', selected: ['o1'], custom: '整体统一' }])).toHaveLength(1)
    expect(() => validateAnswers([question], [{ id: 'q1', selected: ['可行'] }])).toThrow('unknown option id')
    expect(() => validateAnswers([question], [{ id: 'q1', selected: ['o1', 'o2'] }])).toThrow('only one option')
  })

  it('拒绝重复 ID、空回答与未开放的 HTML', () => {
    expect(() => normalizeQuestions([{ id: 'same', question: 'A' }, { id: 'same', question: 'B' }])).toThrow('duplicate id')
    expect(() => normalizeQuestions([{ question: 'A', media: [{ kind: 'html', source: 'x' }] }])).toThrow('kind')
    const questions = normalizeQuestions([{ question: 'A' }])
    expect(() => validateAnswers(questions, [{ id: 'q1', selected: [] }])).toThrow('choose an option')
  })
})

describe('媒体文件边界', () => {
  it('支持 Range，拒绝越界和符号链接逃逸', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsho-media-'))
    const outer = await mkdtemp(join(tmpdir(), 'dsho-outer-'))
    try {
      await mkdir(join(root, 'images'))
      await writeFile(join(root, 'images', 'a.png'), Buffer.from([1, 2, 3, 4]))
      await writeFile(join(outer, 'secret.png'), Buffer.from([5]))
      await symlink(join(outer, 'secret.png'), join(root, 'images', 'escape.png'))
      const result = await mediaResponse(root, 'images/a.png', 'bytes=1-2')
      expect(result.status).toBe(206)
      expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([2, 3])
      expect((await mediaResponse(root, 'images/a.png', 'bytes=10-20')).status).toBe(416)
      await expect(resolveMedia(root, '../secret.png')).rejects.toThrow('relative path')
      await expect(resolveMedia(root, 'images/escape.png')).rejects.toThrow('escapes')
    } finally { await rm(root, { recursive: true, force: true }); await rm(outer, { recursive: true, force: true }) }
  })
})
