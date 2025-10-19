# Handling signed PDF forms with Supabase JS

This guide walks through storing customer signatures and generating a PDF with Supabase JS. It is tailored to a table definition named `SignedForm` that captures the metadata for each signed document.

## Table definition

Create the table with the following JSON definition, which is compatible with the Supabase Dashboard "Create table" dialog and the `supabase db` CLI commands:

```json
{
  "name": "SignedForm",
  "type": "object",
  "properties": {
    "customer_name": {
      "type": "string",
      "description": "Customer's full name"
    },
    "customer_email": {
      "type": "string",
      "format": "email",
      "description": "Customer's email address"
    },
    "signature_date": {
      "type": "string",
      "format": "date",
      "description": "Date when form was signed"
    },
    "original_form_url": {
      "type": "string",
      "description": "URL of the uploaded company form"
    },
    "signature_data": {
      "type": "string",
      "description": "Base64 encoded signature image"
    },
    "signed_form_url": {
      "type": "string",
      "description": "URL of the final signed form document"
    },
    "form_title": {
      "type": "string",
      "description": "Title or description of the form"
    },
    "status": {
      "type": "string",
      "enum": ["pending", "signed", "completed"],
      "default": "pending",
      "description": "Status of the form signing process"
    },
    "staff_creator_email": {
      "type": "string",
      "format": "email",
      "description": "Email of the staff member who initiated this flow"
    }
  },
  "required": ["customer_name", "customer_email", "signature_date", "original_form_url"],
  "rls": {
    "read": {
      "$or": [
        {
          "staff_creator_email": "{{user.email}}"
        },
        {
          "user_condition": {
            "role": "admin"
          }
        }
      ]
    },
    "write": {
      "$or": [
        {
          "staff_creator_email": "{{user.email}}"
        },
        {
          "user_condition": {
            "role": "admin"
          }
        }
      ]
    }
  }
}
```

The RLS policies restrict access to the staff member who created the form and to administrators.

## Fetching the signature image

`signature_data` stores the customer's signature as a Base64 string. When you retrieve the row in a browser environment you can safely convert that string into an in-memory `Uint8Array` and embed it into a PDF generation library. Using the Supabase JavaScript client this looks like:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export async function getSignedForm(formId: string) {
  const { data, error } = await supabase
    .from('SignedForm')
    .select('*')
    .eq('id', formId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Form not found')

  const signatureBytes = Uint8Array.from(atob(data.signature_data), (char) => char.charCodeAt(0))

  return { ...data, signatureBytes }
}
```

If you run the same code in a Node.js environment, replace the `atob` call with `Buffer.from(data.signature_data, 'base64')` to obtain a `Buffer`. The resulting byte array can be passed to PDF libraries such as [`pdf-lib`](https://pdf-lib.js.org/) or [`pdfkit`](https://pdfkit.org/).

## Uploading the generated PDF

Once you merge the original form and the signature, you can upload the finished PDF to Supabase Storage and persist the resulting URL:

```ts
const signedPdfPath = `signed-forms/${formId}.pdf`
const { error: uploadError } = await supabase.storage
  .from('signed-forms')
  .upload(signedPdfPath, pdfBytes, {
    contentType: 'application/pdf',
    upsert: true,
  })

if (uploadError) throw uploadError

const {
  data: { publicUrl },
} = supabase.storage.from('signed-forms').getPublicUrl(signedPdfPath)

await supabase
  .from('SignedForm')
  .update({
    signed_form_url: publicUrl,
    status: 'completed',
  })
  .eq('id', formId)
```

This sequence keeps the signature data in the database for audit purposes and maintains a link to the final PDF that staff members can download.
