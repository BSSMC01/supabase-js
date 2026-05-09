# WhatsApp Cloud API webhook workflow

This example shows how to build a Supabase Edge Function that receives WhatsApp Cloud API webhooks, handles text and supported file messages, performs OCR/AI extraction through a configurable endpoint, detects customer / bank / status fields, updates Google Sheets, stores message history, writes audit logs, and sends WhatsApp plus email notifications.

## What the function does

- Verifies the WhatsApp Cloud API webhook challenge (`GET`).
- Receives webhook events (`POST`) for:
  - Customer or banker text messages.
  - Image messages with `image/jpeg`, `image/jpg`, or `image/png` MIME types.
  - Document messages with `application/pdf`, `image/jpeg`, `image/jpg`, or `image/png` MIME types.
  - WhatsApp delivery/read status updates.
- Downloads supported WhatsApp media from the Graph API.
- Sends text plus optional file bytes to your OCR/AI service.
- Detects `customer`, `bank`, and `status` values from AI output and message text fallbacks.
- Appends a row to Google Sheets.
- Keeps durable history in `whatsapp_message_history`.
- Writes step-by-step audit entries to `whatsapp_audit_log`.
- Sends a WhatsApp acknowledgement and an email notification.

## Files

- `schema.sql` creates the history and audit tables.
- `supabase/functions/whatsapp-cloud-webhook/index.ts` is the Edge Function.

## Required secrets

Set these with `supabase secrets set KEY=value`.

| Secret                         | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `SUPABASE_URL`                 | Project URL.                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`    | Service role key used only inside the Edge Function.         |
| `WHATSAPP_VERIFY_TOKEN`        | Token Meta sends back during webhook verification.           |
| `WHATSAPP_ACCESS_TOKEN`        | WhatsApp Cloud API permanent or system-user access token.    |
| `WHATSAPP_PHONE_NUMBER_ID`     | Phone number ID used for outbound WhatsApp notifications.    |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email with edit access to the target sheet.  |
| `GOOGLE_PRIVATE_KEY`           | Service account private key. Store escaped newlines as `\n`. |
| `GOOGLE_SHEET_ID`              | Spreadsheet ID.                                              |
| `GOOGLE_SHEET_RANGE`           | Append range, for example `Messages!A:Q`.                    |
| `AI_EXTRACTION_URL`            | HTTPS endpoint that performs OCR/AI extraction.              |
| `AI_EXTRACTION_API_KEY`        | Optional bearer token for the OCR/AI endpoint.               |
| `EMAIL_NOTIFICATION_URL`       | Optional HTTPS endpoint for email notifications.             |
| `NOTIFICATION_EMAIL_TO`        | Optional destination email address.                          |

## OCR/AI endpoint contract

The function calls `AI_EXTRACTION_URL` with JSON:

```json
{
  "messageText": "Please process this bank update",
  "mimeType": "application/pdf",
  "filename": "statement.pdf",
  "fileBase64": "JVBERi0x...",
  "senderPhone": "15551234567",
  "senderName": "Customer Name"
}
```

Return JSON with any fields you need. The function looks for these keys first:

```json
{
  "customer": "Jane Customer",
  "bank": "Example Bank",
  "status": "approved",
  "summary": "Loan approval received"
}
```

If your service uses nested fields, `extraction.customer.name`, `extraction.bank.name`, and `extraction.status` are also supported. When the AI endpoint is not configured or does not return a value, the function falls back to simple text detection.

## Google Sheet columns

Create a sheet with these columns in row 1:

1. Timestamp
2. WhatsApp Message ID
3. Direction
4. Sender Phone
5. Sender Name
6. Message Type
7. Message Text
8. Media ID
9. MIME Type
10. Filename
11. Detected Customer
12. Detected Bank
13. Detected Status
14. AI Summary
15. WhatsApp Status
16. Raw JSON
17. Audit Event

## Deploy

```sh
supabase functions deploy whatsapp-cloud-webhook --no-verify-jwt
```

Use the deployed function URL as your WhatsApp webhook callback URL. The webhook must be public because Meta calls it directly.

## Notes

- Keep `SUPABASE_SERVICE_ROLE_KEY`, Google private keys, and WhatsApp tokens out of client-side code.
- The function is idempotent for inbound messages by upserting on `whatsapp_message_id`.
- Unsupported media types are logged to the audit table and ignored instead of failing the whole webhook batch.
