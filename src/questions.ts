import type { QuestionAnswer, QuestionItem } from './types.ts'
import { questionItemInputSchema } from './types.ts'

export function normalizeQuestions(input: unknown): QuestionItem[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) throw new Error('questions: expected 1–10 questions')
  const questions = input.map((item, index) => {
    const parsed = questionItemInputSchema.safeParse(item)
    if (!parsed.success) throw new Error(parsed.error.issues.map(issue =>
      'questions[' + index + ']' + (issue.path.length ? '.' + issue.path.join('.') : '') + ': ' + issue.message,
    ).join('; '))
    const question = parsed.data
    return {
      ...question,
      id: question.id ?? 'q' + (index + 1),
      options: question.options?.map((option, optionIndex) => ({ ...option, id: option.id ?? 'o' + (optionIndex + 1) })),
    }
  })
  const unique = (values: string[]) => new Set(values).size === values.length
  if (!unique(questions.map(item => item.id))) throw new Error('questions: duplicate id')
  for (const [index, question] of questions.entries()) {
    if (question.options && !unique(question.options.map(option => option.id))) throw new Error('questions[' + index + '].options: duplicate id')
    if (question.options && !unique(question.options.map(option => option.label))) throw new Error('questions[' + index + '].options: duplicate label')
  }
  return questions
}

export function validateAnswers(questions: QuestionItem[], answers: QuestionAnswer[]): QuestionAnswer[] {
  if (answers.length !== questions.length) throw new Error('answers: one answer per question is required')
  const byId = new Map<string, QuestionAnswer>()
  for (const [index, answer] of answers.entries()) {
    if (byId.has(answer.id)) throw new Error('answers[' + index + '].id: duplicate question id')
    byId.set(answer.id, answer)
  }
  return questions.map((question, index) => {
    const answer = byId.get(question.id)
    if (!answer) throw new Error('answers[' + index + '].id: missing question ' + question.id)
    if (new Set(answer.selected).size !== answer.selected.length) throw new Error('answers[' + index + '].selected: duplicate option id')
    const allowed = new Set(question.options?.map(option => option.id) ?? [])
    if (answer.selected.some(id => !allowed.has(id))) throw new Error('answers[' + index + '].selected: unknown option id')
    if (!question.multi_select && answer.selected.length > 1) throw new Error('answers[' + index + '].selected: only one option allowed')
    if (answer.selected.length === 0 && !answer.custom?.trim()) throw new Error('answers[' + index + ']: choose an option or enter custom text')
    return answer
  })
}
