import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH_API_VERSION = 'v20.0'
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'])

type JsonRecord = Record<string, unknown>

type WhatsAppMessage = {
  id: string
  from: string
  timestamp?: string
  type: string
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
}

type WhatsAppStatus = {
  id: string
  status: string
  timestamp?: string
  recipient_id?: string
  conversation?: JsonRecord
  pricing?: JsonRecord
}

type MediaPayload = {
  id: string
  mimeType: string
  filename?: string
  base64: string
}

type DetectionResult = {
  customer: string
  bank: string
  status: string
  summary: string
  extraction: JsonRecord
}

const env = (key: string, fallback = '') => Deno.env.get(key) ?? fallback

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

Deno.serve(async (request) => {
  try {
    if (request.method === 'GET') return verifyWebhook(request)
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    const payload = await request.json()
    await audit('webhook.received', undefined, 'info', { payload })

    const events = collectWebhookEvents(payload)
    for (const event of events) {
      if (event.message) {
        await handleMessage(event.message, event.contact, event.phoneNumberId, payload)
      }

      if (event.status) {
        await handleStatus(event.status, payload)
      }
    }

    return json({ ok: true, processed: events.length })
  } catch (error) {
    await audit('webhook.error', undefined, 'error', serializeError(error))
    return json({ error: 'Webhook processing failed' }, 500)
  }
})

function verifyWebhook(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === env('WHATSAPP_VERIFY_TOKEN') && challenge) {
    return new Response(challenge, { status: 200 })
  }

  return new Response('Forbidden', { status: 403 })
}

function collectWebhookEvents(payload: JsonRecord) {
  const events: Array<{
    message?: WhatsAppMessage
    status?: WhatsAppStatus
    contact?: { wa_id?: string; profile?: { name?: string } }
    phoneNumberId?: string
  }> = []

  for (const entry of asArray<JsonRecord>(payload.entry)) {
    for (const change of asArray<JsonRecord>(entry.changes)) {
      const value = (change.value ?? {}) as JsonRecord
      const metadata = (value.metadata ?? {}) as JsonRecord
      const phoneNumberId = stringValue(metadata.phone_number_id)
      const contacts = asArray<{ wa_id?: string; profile?: { name?: string } }>(value.contacts)

      for (const message of asArray<WhatsAppMessage>(value.messages)) {
        events.push({ message, contact: contacts[0], phoneNumberId })
      }

      for (const status of asArray<WhatsAppStatus>(value.statuses)) {
        events.push({ status, phoneNumberId })
      }
    }
  }

  return events
}

async function handleMessage(
  message: WhatsAppMessage,
  contact: { wa_id?: string; profile?: { name?: string } } | undefined,
  phoneNumberId: string | undefined,
  rawPayload: JsonRecord
) {
  const senderName = contact?.profile?.name ?? ''
  const messageText =
    message.text?.body ?? message.image?.caption ?? message.document?.caption ?? ''
  const media = await downloadSupportedMedia(message)
  const detection = await detectFields(messageText, media, message.from, senderName)

  const history = {
    whatsapp_message_id: message.id,
    direction: 'inbound',
    sender_phone: message.from,
    recipient_phone: phoneNumberId ?? '',
    sender_name: senderName,
    message_type: message.type,
    body: messageText,
    media_id: media?.id ?? null,
    media_mime_type: media?.mimeType ?? null,
    media_filename: media?.filename ?? null,
    detected_customer: detection.customer,
    detected_bank: detection.bank,
    detected_status: detection.status,
    extraction: detection.extraction,
    raw_payload: rawPayload,
  }

  const { error } = await supabase
    .from('whatsapp_message_history')
    .upsert(history, { onConflict: 'whatsapp_message_id' })

  if (error) throw error

  await audit('message.history_saved', message.id, 'info', history)
  await appendGoogleSheetRow(message, senderName, media, detection, rawPayload)
  await sendWhatsAppNotification(message.from, detection)
  await sendEmailNotification(message, senderName, media, detection)
}

async function handleStatus(status: WhatsAppStatus, rawPayload: JsonRecord) {
  const history = {
    whatsapp_message_id: status.id,
    direction: 'status',
    sender_phone: null,
    recipient_phone: status.recipient_id ?? null,
    sender_name: null,
    message_type: 'status',
    body: status.status,
    detected_status: status.status,
    extraction: { conversation: status.conversation, pricing: status.pricing },
    raw_payload: rawPayload,
  }

  const { error } = await supabase
    .from('whatsapp_message_history')
    .upsert(history, { onConflict: 'whatsapp_message_id' })

  if (error) throw error

  await audit('message.status_saved', status.id, 'info', history)
  await appendGoogleSheetStatusRow(status, rawPayload)
}

async function downloadSupportedMedia(message: WhatsAppMessage): Promise<MediaPayload | undefined> {
  const mediaId = message.image?.id ?? message.document?.id
  const mimeType = message.image?.mime_type ?? message.document?.mime_type ?? ''
  const filename = message.document?.filename

  if (!mediaId) return undefined

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    await audit('media.unsupported_type', message.id, 'warning', { mediaId, mimeType, filename })
    return undefined
  }

  const metadataResponse = await graphFetch(`/${mediaId}`)
  const mediaUrl = stringValue(metadataResponse.url)
  if (!mediaUrl) throw new Error(`No download URL returned for media ${mediaId}`)

  const fileResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}` },
  })

  if (!fileResponse.ok) {
    throw new Error(`Failed to download WhatsApp media ${mediaId}: ${fileResponse.status}`)
  }

  const bytes = new Uint8Array(await fileResponse.arrayBuffer())
  return { id: mediaId, mimeType, filename, base64: encodeBase64(bytes) }
}

async function detectFields(
  messageText: string,
  media: MediaPayload | undefined,
  senderPhone: string,
  senderName: string
): Promise<DetectionResult> {
  const extraction = await callAiExtraction(messageText, media, senderPhone, senderName)
  const customer = firstString(
    extraction.customer,
    nested(extraction, 'customer', 'name'),
    senderName
  )
  const bank = firstString(
    extraction.bank,
    nested(extraction, 'bank', 'name'),
    detectBank(messageText)
  )
  const status = firstString(extraction.status, detectStatus(messageText), 'received')
  const summary = firstString(extraction.summary, messageText.slice(0, 500))

  return { customer, bank, status, summary, extraction }
}

async function callAiExtraction(
  messageText: string,
  media: MediaPayload | undefined,
  senderPhone: string,
  senderName: string
): Promise<JsonRecord> {
  const aiUrl = env('AI_EXTRACTION_URL')
  if (!aiUrl) return {}

  const response = await fetch(aiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env('AI_EXTRACTION_API_KEY')
        ? { Authorization: `Bearer ${env('AI_EXTRACTION_API_KEY')}` }
        : {}),
    },
    body: JSON.stringify({
      messageText,
      mimeType: media?.mimeType,
      filename: media?.filename,
      fileBase64: media?.base64,
      senderPhone,
      senderName,
    }),
  })

  if (!response.ok) {
    await audit('ai.extraction_failed', undefined, 'warning', { status: response.status })
    return {}
  }

  return (await response.json()) as JsonRecord
}

async function appendGoogleSheetRow(
  message: WhatsAppMessage,
  senderName: string,
  media: MediaPayload | undefined,
  detection: DetectionResult,
  rawPayload: JsonRecord
) {
  const spreadsheetId = env('GOOGLE_SHEET_ID')
  const range = env('GOOGLE_SHEET_RANGE', 'Messages!A:Q')
  if (!spreadsheetId) return

  const accessToken = await getGoogleAccessToken()
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range
    )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [
          [
            new Date().toISOString(),
            message.id,
            'inbound',
            message.from,
            senderName,
            message.type,
            message.text?.body ?? message.image?.caption ?? message.document?.caption ?? '',
            media?.id ?? '',
            media?.mimeType ?? '',
            media?.filename ?? '',
            detection.customer,
            detection.bank,
            detection.status,
            detection.summary,
            '',
            JSON.stringify(rawPayload),
            'message.processed',
          ],
        ],
      }),
    }
  )

  if (!response.ok) throw new Error(`Google Sheets append failed: ${response.status}`)
  await audit('sheet.row_appended', message.id, 'info', { spreadsheetId, range })
}

async function appendGoogleSheetStatusRow(status: WhatsAppStatus, rawPayload: JsonRecord) {
  const spreadsheetId = env('GOOGLE_SHEET_ID')
  const range = env('GOOGLE_SHEET_RANGE', 'Messages!A:Q')
  if (!spreadsheetId) return

  const accessToken = await getGoogleAccessToken()
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range
    )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [
          [
            new Date().toISOString(),
            status.id,
            'status',
            '',
            '',
            'status',
            status.status,
            '',
            '',
            '',
            '',
            '',
            status.status,
            '',
            status.status,
            JSON.stringify(rawPayload),
            'message.status_saved',
          ],
        ],
      }),
    }
  )

  if (!response.ok) throw new Error(`Google Sheets status append failed: ${response.status}`)
  await audit('sheet.status_row_appended', status.id, 'info', { spreadsheetId, range })
}

async function sendWhatsAppNotification(to: string, detection: DetectionResult) {
  if (!env('WHATSAPP_PHONE_NUMBER_ID')) return

  const text = [
    'Thanks, we received your message.',
    detection.customer ? `Customer: ${detection.customer}` : '',
    detection.bank ? `Bank: ${detection.bank}` : '',
    detection.status ? `Status: ${detection.status}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const response = await graphFetch(`/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  })

  await audit('notification.whatsapp_sent', undefined, 'info', response)
}

async function sendEmailNotification(
  message: WhatsAppMessage,
  senderName: string,
  media: MediaPayload | undefined,
  detection: DetectionResult
) {
  const emailUrl = env('EMAIL_NOTIFICATION_URL')
  if (!emailUrl) return

  const response = await fetch(emailUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: env('NOTIFICATION_EMAIL_TO'),
      subject: `WhatsApp update: ${detection.status || 'received'}`,
      messageId: message.id,
      senderPhone: message.from,
      senderName,
      media: media
        ? { id: media.id, mimeType: media.mimeType, filename: media.filename }
        : undefined,
      detection,
    }),
  })

  if (!response.ok) throw new Error(`Email notification failed: ${response.status}`)
  await audit('notification.email_sent', message.id, 'info', { status: response.status })
}

async function graphFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
      ...headersRecord(init.headers),
    },
  })

  if (!response.ok) throw new Error(`Graph API request failed: ${response.status}`)
  return (await response.json()) as JsonRecord
}

async function getGoogleAccessToken() {
  const email = env('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const privateKey = env('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n')
  if (!email || !privateKey) throw new Error('Google service account secrets are missing')

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }
  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJwt)
  )
  const jwt = `${unsignedJwt}.${base64Url(new Uint8Array(signature))}`

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`)
  const token = (await response.json()) as { access_token?: string }
  if (!token.access_token) throw new Error('Google token response did not include access_token')
  return token.access_token
}

async function audit(
  eventType: string,
  whatsappMessageId: string | undefined,
  severity: 'info' | 'warning' | 'error',
  details: JsonRecord
) {
  const { error } = await supabase.from('whatsapp_audit_log').insert({
    event_type: eventType,
    whatsapp_message_id: whatsappMessageId ?? null,
    severity,
    details,
  })

  if (error) console.error('Failed to write WhatsApp audit log', error)
}

function headersRecord(headers: HeadersInit | undefined) {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

function detectBank(text: string) {
  const match = text.match(/(?:bank|lender)\s*[:\-]\s*([^\n,]+)/i)
  return match?.[1]?.trim() ?? ''
}

function detectStatus(text: string) {
  const statuses = ['approved', 'rejected', 'pending', 'submitted', 'funded', 'closed', 'received']
  return statuses.find((status) => new RegExp(`\\b${status}\\b`, 'i').test(text)) ?? ''
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function nested(record: JsonRecord, ...path: string[]) {
  let current: unknown = record
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as JsonRecord)[key]
  }
  return current
}

function serializeError(error: unknown): JsonRecord {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Url(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return encodeBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
