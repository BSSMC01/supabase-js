import type {
  BankerStatusDetectionResult,
  BankerStatusKeywordConfig,
  BankerStatusKeywordRule,
  BankerWorkflowLanguage,
  BankerWorkflowStatus,
} from '../types/banker-workflow.types'

declare const require: (path: string) => BankerStatusKeywordConfig

const keywordConfig = require('../rules/banker-status-keywords.json')

const STATUS_PRIORITY: BankerWorkflowStatus[] = [
  'disbursed',
  'approved',
  'rejected',
  'pending_documents',
  'pending_information',
  'under_review',
  'submitted_to_bank',
  'unknown',
]

const BANKER_INTENT_BASE_CONFIDENCE = 0.2
const BANKER_INTENT_STATUS_CONFIDENCE = 0.45
const BANKER_INTENT_BANKER_INDICATOR_CONFIDENCE = 0.35
const BANKER_INTENT_REFERENCE_INDICATOR_CONFIDENCE = 0.15
const BANKER_INTENT_THRESHOLD = 0.55

const LANGUAGE_KEYWORDS: Record<Exclude<BankerWorkflowLanguage, 'unknown'>, string[]> = {
  en: [
    'approved',
    'rejected',
    'declined',
    'pending',
    'documents',
    'under review',
    'submitted',
    'disbursed',
    'bank',
    'loan',
    'case',
  ],
  ms: [
    'diluluskan',
    'ditolak',
    'dokumen',
    'semakan',
    'diproses',
    'kelulusan',
    'dihantar',
    'pinjaman',
    'permohonan',
    'bank',
  ],
  zh: ['批准', '拒绝', '文件', '资料', '审核', '处理', '提交', '放款', '银行', '贷款', '案件'],
}

export class BankerStatusService {
  detect(message: string): BankerStatusDetectionResult {
    const normalizedMessage = normalizeText(message)

    if (!normalizedMessage) {
      return buildResult({
        isBankerStatusUpdate: false,
        bankerIntentConfidence: 0,
        status: 'unknown',
        workflowStatusConfidence: 0,
        matchedPhrase: null,
        matchedKeywords: [],
        language: 'unknown',
        requiresManualReview: false,
      })
    }

    const bankerIndicatorMatches = findMatchedPhrases(
      normalizedMessage,
      keywordConfig.bankerIndicators
    )
    const referenceIndicatorMatches = findMatchedPhrases(
      normalizedMessage,
      keywordConfig.referenceIndicators
    )
    const statusMatches = this.findStatusMatches(normalizedMessage)
    const strongestStatusMatch = statusMatches.sort(compareStatusMatches)[0]
    const hasAmbiguousStatuses = countDistinctStatuses(statusMatches) > 1
    const bankerIntentConfidence = calculateBankerIntentConfidence({
      hasStatusMatch: Boolean(strongestStatusMatch),
      bankerIndicatorCount: bankerIndicatorMatches.length,
      referenceIndicatorCount: referenceIndicatorMatches.length,
    })
    const isBankerStatusUpdate = bankerIntentConfidence >= BANKER_INTENT_THRESHOLD
    const status = strongestStatusMatch?.status ?? 'unknown'
    const workflowStatusConfidence = isBankerStatusUpdate
      ? strongestStatusMatch?.confidence ?? 0
      : 0
    const matchedPhrase = isBankerStatusUpdate ? strongestStatusMatch?.phrase ?? null : null
    const statusMatchedKeywords = statusMatches.flatMap((match) => match.keywords)
    const matchedKeywords = isBankerStatusUpdate
      ? uniqueKeywords([
          ...statusMatchedKeywords,
          ...bankerIndicatorMatches.map((match) => match.phrase),
          ...referenceIndicatorMatches.map((match) => match.phrase),
        ])
      : []

    return buildResult({
      isBankerStatusUpdate,
      bankerIntentConfidence,
      status: isBankerStatusUpdate ? status : 'unknown',
      workflowStatusConfidence,
      matchedPhrase,
      matchedKeywords,
      language: detectLanguage(normalizedMessage, matchedKeywords),
      requiresManualReview: isBankerStatusUpdate && (hasAmbiguousStatuses || status === 'unknown'),
    })
  }

  private findStatusMatches(normalizedMessage: string): StatusMatch[] {
    const matches: StatusMatch[] = []

    for (const status of STATUS_PRIORITY) {
      if (status === 'unknown') {
        continue
      }

      const rule = keywordConfig.statuses[status]
      const matchedKeywords = findMatchedStatusPhrases(normalizedMessage, rule)

      if (matchedKeywords.length === 0) {
        continue
      }

      const strongestPhrase = matchedKeywords.sort(comparePhraseMatches)[0]

      matches.push({
        status,
        confidence: rule.confidence,
        phrase: strongestPhrase.phrase,
        keywords: matchedKeywords.map((match) => match.phrase),
      })
    }

    return matches
  }
}

interface StatusMatch {
  status: BankerWorkflowStatus
  confidence: number
  phrase: string
  keywords: string[]
}

interface PhraseMatch {
  phrase: string
  normalizedPhrase: string
}

interface BankerIntentConfidenceInput {
  hasStatusMatch: boolean
  bankerIndicatorCount: number
  referenceIndicatorCount: number
}

function findMatchedStatusPhrases(
  normalizedMessage: string,
  rule: BankerStatusKeywordRule
): PhraseMatch[] {
  const negativeKeywords = rule.negativeKeywords ?? []
  const matchedNegativeKeywords = findMatchedPhrases(normalizedMessage, negativeKeywords)

  if (matchedNegativeKeywords.length > 0) {
    return []
  }

  return findMatchedPhrases(normalizedMessage, rule.keywords)
}

function findMatchedPhrases(normalizedMessage: string, phrases: string[]): PhraseMatch[] {
  return phrases
    .map((phrase) => ({ phrase, normalizedPhrase: normalizeText(phrase) }))
    .filter((match) => phraseMatches(normalizedMessage, match.normalizedPhrase))
}

function phraseMatches(normalizedMessage: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) {
    return false
  }

  if (containsCjk(normalizedPhrase)) {
    return normalizedMessage.includes(normalizedPhrase)
  }

  const escapedPhrase = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flexibleWhitespacePhrase = escapedPhrase.replace(/\s+/g, '\\s+')
  const phrasePattern = new RegExp(`(^|\\W)${flexibleWhitespacePhrase}(?=\\W|$)`, 'i')

  return phrasePattern.test(normalizedMessage)
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。；：！？、]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compareStatusMatches(first: StatusMatch, second: StatusMatch): number {
  if (second.confidence !== first.confidence) {
    return second.confidence - first.confidence
  }

  return STATUS_PRIORITY.indexOf(first.status) - STATUS_PRIORITY.indexOf(second.status)
}

function comparePhraseMatches(first: PhraseMatch, second: PhraseMatch): number {
  return second.normalizedPhrase.length - first.normalizedPhrase.length
}

function countDistinctStatuses(matches: StatusMatch[]): number {
  return new Set(matches.map((match) => match.status)).size
}

function calculateBankerIntentConfidence(input: BankerIntentConfidenceInput): number {
  if (!input.hasStatusMatch && input.bankerIndicatorCount === 0) {
    return 0
  }

  const confidence =
    BANKER_INTENT_BASE_CONFIDENCE +
    (input.hasStatusMatch ? BANKER_INTENT_STATUS_CONFIDENCE : 0) +
    Math.min(input.bankerIndicatorCount, 1) * BANKER_INTENT_BANKER_INDICATOR_CONFIDENCE +
    Math.min(input.referenceIndicatorCount, 1) * BANKER_INTENT_REFERENCE_INDICATOR_CONFIDENCE

  return capConfidence(confidence)
}

function detectLanguage(
  normalizedMessage: string,
  matchedKeywords: string[]
): BankerWorkflowLanguage {
  const searchableText = `${normalizedMessage} ${matchedKeywords.join(' ')}`

  if (containsCjk(searchableText)) {
    return 'zh'
  }

  const scores = {
    en: countLanguageMatches(searchableText, LANGUAGE_KEYWORDS.en),
    ms: countLanguageMatches(searchableText, LANGUAGE_KEYWORDS.ms),
  }

  if (scores.ms > scores.en) {
    return 'ms'
  }

  if (scores.en > 0) {
    return 'en'
  }

  if (scores.ms > 0) {
    return 'ms'
  }

  return 'unknown'
}

function countLanguageMatches(text: string, keywords: string[]): number {
  return keywords.filter((keyword) => phraseMatches(text, normalizeText(keyword))).length
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

function capConfidence(confidence: number): number {
  return Math.min(1, Number(confidence.toFixed(2)))
}

function uniqueKeywords(keywords: string[]): string[] {
  return [...new Set(keywords)]
}

function buildResult(result: BankerStatusDetectionResult): BankerStatusDetectionResult {
  return result
}

export const bankerStatusService = new BankerStatusService()
