import type { ConversationRecord } from './types.ts'

export interface RouteCandidate {
  conversation: ConversationRecord
  score: number
  reasons: string[]
}

interface TopicGroup {
  topic: string
  terms: RegExp
}

const topicGroups: TopicGroup[] = [
  { topic: 'weather', terms: /天气|气温|温度|下雨|降雨|降水|预报|冷|热|穿(什么|啥)|穿衣|衣服|外套|伞|weather|temperature|forecast|rain|wear|clothes|clothing|umbrella/i },
  { topic: 'code', terms: /代码|程序|仓库|bug|报错|测试|重构|实现|编译|code|program|repo|repository|bug|error|test|refactor|build/i },
  { topic: 'research', terms: /资料|调研|查找|对比|论文|新闻|公司|市场|research|paper|news|market|compare/i },
  { topic: 'review', terms: /审查|评审|review|audit|inspect|只读/i },
  { topic: 'schedule', terms: /提醒|日程|约会|截止|reminder|schedule|calendar|deadline/i },
  { topic: 'finance', terms: /钱|价格|账单|股票|基金|预算|money|price|bill|stock|budget|finance/i },
]

const FOLLOW_UP_CUES = /改成|改为|换成|不要|别用|不是|我要|继续|还是|顺便|刚刚|刚才|上面|调成|调为|新增|加个|加一|去掉|删掉|放大|缩小|背景|颜色|风格|能不能|可以吗|怎么样|呢$|吧$|吗$/

/** 短查询是否像对当前产物的追问或改单，而非一个全新独立话题。 */
export function looksLikeFollowUp(query: string): boolean {
  return FOLLOW_UP_CUES.test(query.trim())
}
const LATIN = /[a-z0-9][a-z0-9+#.-]{1,}/gi
const CJK = /[\u4e00-\u9fff]+/g

function unique(values: string[]): string[] {
  return [...new Set(values.map(v => v.toLowerCase()).filter(Boolean))]
}

export function lexicalTokens(text: string): string[] {
  const latin = text.toLowerCase().match(LATIN) ?? []
  const cjkBlocks = text.match(CJK) ?? []
  const bigrams = cjkBlocks.flatMap(block => Array.from({ length: Math.max(0, block.length - 1) }, (_, i) => block.slice(i, i + 2)))
  return unique([...latin, ...bigrams])
}

export function inferTopics(text: string): string[] {
  return topicGroups.filter(group => group.terms.test(text)).map(group => group.topic)
}

function conversationText(conv: ConversationRecord): string {
  return [
    conv.title,
    conv.outline.summary,
    conv.outline.keyFacts.join(' '),
    conv.outline.entities.join(' '),
    conv.outline.tags.join(' '),
    conv.outline.openQuestions.join(' '),
  ].join('\n')
}

function intersect<T>(left: readonly T[], right: readonly T[]): T[] {
  const rightSet = new Set(right)
  return [...new Set(left.filter(item => rightSet.has(item)))]
}

export function scoreConversation(query: string, conv: ConversationRecord): RouteCandidate {
  const queryTokens = lexicalTokens(query)
  const text = conversationText(conv)
  const sharedTokens = intersect(queryTokens, lexicalTokens(text))
  const queryTopics = inferTopics(query)
  const convTopics = inferTopics(text)
  const sharedTopics = intersect(queryTopics, convTopics)
  const entities = inferTopics(`${conv.title}\n${conv.outline.entities.join('\n')}\n${conv.outline.tags.join('\n')}`)
  const sharedEntityTopics = intersect(queryTopics, entities)

  let score = sharedTokens.length * 2 + sharedTopics.length * 8 + sharedEntityTopics.length * 3
  if (/今天|今日|明天|现在|current|today|tomorrow/i.test(query) && /天气|气温|weather|temperature/i.test(text)) score += 2
  if (sharedTokens.length > 0) score += Math.min(6, sharedTokens.length)
  if (conv.state === 'failed') score -= 4

  const reasons: string[] = []
  if (sharedTopics.length) reasons.push(`主题相关：${sharedTopics.join('、')}`)
  if (sharedTokens.length) reasons.push(`关键词重合：${sharedTokens.slice(0, 6).join('、')}`)
  return { conversation: conv, score, reasons }
}

export function routeQuery(
  query: string,
  conversations: readonly ConversationRecord[],
  threshold = 8,
): RouteCandidate[] {
  const scored = conversations
    .map(conv => scoreConversation(query, conv))
    .sort((a, b) => b.score - a.score || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
  const hits = scored.filter(candidate => candidate.score >= threshold)
  if (hits.length > 0) return hits

  // 兜底：追问/改需求通常很短（如“改成白天背景”“不要星空”），纯词法打分会 0 命中。
  // 只有一个工作流、且查询呈现改单/追问语气（指示代词、否定修改、祈使动词等）时才兜底，
  // 避免把“帮我规划午餐预算”这类全新话题错误并入旧工作流。
  if (conversations.length === 1 && conversations[0]!.state !== 'failed' && looksLikeFollowUp(query)) {
    return [{
      conversation: conversations[0]!,
      score: 0,
      reasons: ['唯一工作流兜底：检测到追问/改单语气，默认复用当前唯一子会话'],
    }]
  }
  return []
}
