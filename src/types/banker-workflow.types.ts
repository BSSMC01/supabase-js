export type BankerWorkflowStatus =
  | 'approved'
  | 'rejected'
  | 'pending_documents'
  | 'pending_information'
  | 'under_review'
  | 'submitted_to_bank'
  | 'disbursed'
  | 'unknown'

export type BankerWorkflowLanguage = 'en' | 'ms' | 'zh' | 'unknown'

export interface BankerStatusDetectionResult {
  isBankerStatusUpdate: boolean
  bankerIntentConfidence: number
  status: BankerWorkflowStatus
  workflowStatusConfidence: number
  matchedPhrase: string | null
  matchedKeywords: string[]
  language: BankerWorkflowLanguage
  requiresManualReview: boolean
}

export interface BankerStatusKeywordRule {
  keywords: string[]
  negativeKeywords?: string[]
  confidence: number
}

export type BankerStatusKeywordRules = Record<BankerWorkflowStatus, BankerStatusKeywordRule>

export interface BankerStatusKeywordConfig {
  statuses: BankerStatusKeywordRules
  bankerIndicators: string[]
  referenceIndicators: string[]
}
