import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1'

Deno.serve(async (req) => {
  try {
    const { token, email } = await req.json()

    if (!token || !email) {
      return new Response(
        JSON.stringify({ success: false, error: 'Token and email are required.' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const base44 = createClientFromRequest(req).asServiceRole

    // Find the link by token
    const links = await base44.entities.SecureLink.filter({ token })

    if (links.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid or expired link.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const link = links[0]

    // Check if the link is in the correct state
    if (link.status !== 'pending') {
      return new Response(
        JSON.stringify({ success: false, error: 'This link has already been used.' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Expiration check
    const now = new Date()
    const expiration = new Date(link.expires_at)
    if (expiration.getTime() < now.getTime()) {
      return new Response(JSON.stringify({ success: false, error: 'This link has expired.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify the email address (case-insensitive comparison)
    if (email.toLowerCase().trim() !== link.customer_email.toLowerCase().trim()) {
      return new Response(
        JSON.stringify({ success: false, error: 'Email address does not match our records.' }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // If all checks pass, update the status
    await base44.entities.SecureLink.update(link.id, { status: 'verified' })

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Email verification successful.',
        customer_name: link.customer_name,
        customer_email: link.customer_email,
        secure_link_id: link.id,
        staff_creator_email: link.staff_creator_email,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Verification function error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: 'An internal server error occurred. Please try again.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
})
