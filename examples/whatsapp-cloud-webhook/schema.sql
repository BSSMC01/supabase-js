-- WhatsApp Cloud API webhook history and audit tables.
-- Run this in the Supabase SQL editor before deploying the Edge Function.

create table if not exists public.whatsapp_message_history (
  id uuid primary key default gen_random_uuid(),
  whatsapp_message_id text unique,
  direction text not null check (direction in ('inbound', 'outbound', 'status')),
  sender_phone text,
  recipient_phone text,
  sender_name text,
  message_type text,
  body text,
  media_id text,
  media_mime_type text,
  media_filename text,
  detected_customer text,
  detected_bank text,
  detected_status text,
  extraction jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_message_history_sender_phone_idx
  on public.whatsapp_message_history (sender_phone);

create index if not exists whatsapp_message_history_created_at_idx
  on public.whatsapp_message_history (created_at desc);

create table if not exists public.whatsapp_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  whatsapp_message_id text,
  severity text not null default 'info' check (severity in ('info', 'warning', 'error')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_audit_log_message_id_idx
  on public.whatsapp_audit_log (whatsapp_message_id);

create index if not exists whatsapp_audit_log_created_at_idx
  on public.whatsapp_audit_log (created_at desc);
