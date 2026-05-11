import { BankerStatusService } from '../src/services/banker-status.service'

describe('BankerStatusService', () => {
  const service = new BankerStatusService()

  test('detects approved banker workflow updates with separate confidence scores', () => {
    const result = service.detect('Case BOSEN-2026-0001 loan approved by bank')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'approved',
      workflowStatusConfidence: 0.86,
      matchedPhrase: 'approved by bank',
      language: 'en',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining([
        'approved',
        'loan approved',
        'approved by bank',
        'bank',
        'case',
        'loan',
      ])
    )
  })

  test('detects rejected banker workflow updates', () => {
    const result = service.detect('Application declined due to DSR')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 0.8,
      status: 'rejected',
      workflowStatusConfidence: 0.88,
      matchedPhrase: 'declined due',
      language: 'en',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(expect.arrayContaining(['declined', 'declined due']))
  })

  test('detects pending document banker workflow updates', () => {
    const result = service.detect(
      'Need docs for borrower: latest payslip and bank statement required'
    )

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'pending_documents',
      workflowStatusConfidence: 0.84,
      matchedPhrase: 'bank statement required',
      language: 'en',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining(['need docs', 'bank statement required', 'bank', 'borrower'])
    )
  })

  test('maps pending approval to under review', () => {
    const result = service.detect('Bank case pending approval')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'under_review',
      workflowStatusConfidence: 0.78,
      matchedPhrase: 'pending approval',
      language: 'en',
      requiresManualReview: false,
    })
  })

  test('maps KIV to pending information', () => {
    const result = service.detect('Banker update for borrower case: KIV')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'pending_information',
      workflowStatusConfidence: 0.8,
      matchedPhrase: 'kiv',
      language: 'en',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(expect.arrayContaining(['kiv', 'banker', 'borrower']))
  })

  test('supports Bahasa Malaysia banker workflow detection', () => {
    const result = service.detect('Kes pinjaman telah diluluskan oleh bank')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'approved',
      workflowStatusConfidence: 0.86,
      matchedPhrase: 'diluluskan',
      language: 'ms',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining(['diluluskan', 'bank', 'kes', 'pinjaman'])
    )
  })

  test('supports Chinese banker workflow detection', () => {
    const result = service.detect('银行通知：案件贷款已发放')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'disbursed',
      workflowStatusConfidence: 0.9,
      matchedPhrase: '贷款已发放',
      language: 'zh',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining(['贷款已发放', '银行', '案件', '贷款'])
    )
  })

  test('flags ambiguous banker workflow messages for manual review', () => {
    const result = service.detect('Bank case approved but pending docs')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      bankerIntentConfidence: 1,
      status: 'approved',
      workflowStatusConfidence: 0.86,
      matchedPhrase: 'approved',
      language: 'en',
      requiresManualReview: true,
    })
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining(['approved', 'pending docs', 'bank', 'case'])
    )
  })

  test('does not treat non-banker messages as banker workflow updates', () => {
    const result = service.detect('Hi, I want to apply for a housing loan')

    expect(result).toEqual({
      isBankerStatusUpdate: false,
      bankerIntentConfidence: 0,
      status: 'unknown',
      workflowStatusConfidence: 0,
      matchedPhrase: null,
      matchedKeywords: [],
      language: 'en',
      requiresManualReview: false,
    })
  })

  test('does not treat rm as a banker indicator', () => {
    const result = service.detect('rm')

    expect(result).toEqual({
      isBankerStatusUpdate: false,
      bankerIntentConfidence: 0,
      status: 'unknown',
      workflowStatusConfidence: 0,
      matchedPhrase: null,
      matchedKeywords: [],
      language: 'unknown',
      requiresManualReview: false,
    })
  })

  test('uses negative keywords to avoid classifying pending approval as approved', () => {
    const result = service.detect('Application pending approval by bank')

    expect(result).toMatchObject({
      isBankerStatusUpdate: true,
      status: 'under_review',
      workflowStatusConfidence: 0.78,
      matchedPhrase: 'pending approval',
      requiresManualReview: false,
    })
    expect(result.matchedKeywords).not.toContain('approved')
  })
})
