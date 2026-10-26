// Supabase project for sign-in and sync (Phase 2).
// The anon key is designed to be public: your data is protected by the row-level security rules
// in supabase/schema.sql, so it is safe in this file and in your GitHub repo.
// NEVER put the service_role key here.
export const SUPABASE_URL = 'https://lwwhoinoredwathgmdij.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3d2hvaW5vcmVkd2F0aGdtZGlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5ODE5MjYsImV4cCI6MjEwODU1NzkyNn0.aS3g6Sbeg_mHMzZXnhV0PvGX18NfD0q5IyOfIbU5S3Q'; // Supabase → Project Settings → API → anon public

// Public half of your web-push (VAPID) key pair, for alerts. Generate the pair with tools/vapid-keys.html.
// The PRIVATE half goes only into Supabase → Edge Functions → Secrets, never here.
export const VAPID_PUBLIC_KEY = 'BHrkfwgrz-W1xqiZm8pmmlAzARZRXQXZ1tBbEsPR89btWHTo91I8y1JgNe9AhPJ-4OIQV_hbgJqWX5fRrlgzkRU';
