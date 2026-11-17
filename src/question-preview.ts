import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { QuestionItem } from './types.ts'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
}
const MAX_BYTES = 100 * 1024 * 1024

export function mediaPaths(questions: QuestionItem[]): string[] {
  return questions.flatMap(question => [
    ...(question.media ?? []).flatMap(item => [item.source, ...(item.poster ? [item.poster] : [])]),
    ...(question.options ?? []).flatMap(option => option.preview ? [option.preview.source, ...(option.preview.poster ? [option.preview.poster] : [])] : []),
  ])
}

export async function resolveMedia(root: string, source: string): Promise<{ path: string; size: number; mime: string }> {
  if (!source || isAbsolute(source) || /^[a-zA-Z]:/.test(source) || source.split(/[\\/]/).includes('..')) throw new Error('source: working-directory relative path required')
  const base = await realpath(root)
  const path = await realpath(resolve(base, source))
  const rel = relative(base, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('source: path escapes the session workspace')
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('source: unsupported file or exceeds 100 MiB')
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error('source: unsupported media type')
  return { path, size: info.size, mime }
}

export async function mediaResponse(root: string, source: string, range?: string): Promise<Response> {
  const file = await resolveMedia(root, source)
  const match = range?.match(/^bytes=([0-9]*)-([0-9]*)$/)
  if (range && !match) return new Response(null, { status: 416 })
  const suffix = match && !match[1] && match[2] ? Number(match[2]) : undefined
  if (suffix === 0) return new Response(null, { status: 416 })
  const start = suffix === undefined ? (match?.[1] ? Number(match[1]) : 0) : Math.max(0, file.size - suffix)
  const end = suffix === undefined && match?.[2] ? Number(match[2]) : file.size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= file.size) return new Response(null, { status: 416 })
  const stream = createReadStream(file.path, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers: {
      'content-type': file.mime,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + file.size } : {},
    },
  })
}
