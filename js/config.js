// Supabase project for sign-in and sync (Phase 2).
// The anon key is designed to be public: your data is protected by the row-level security rules
// in supabase/schema.sql, so it is safe in this file and in your GitHub repo.
// NEVER put the service_role key here.
export const SUPABASE_URL = 'https://lwwhoinoredwathgmdij.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_dnqANaGlhgZQ3mnwQG6YLw_MEmkLh7f'; // Supabase → Project Settings → API → anon public

// Public half of your web-push (VAPID) key pair, for alerts. Generate the pair with tools/vapid-keys.html.
// The PRIVATE half goes only into Supabase → Edge Functions → Secrets, never here.
export const VAPID_PUBLIC_KEY = 'BHrkfwgrz-W1xqiZm8pmmlAzARZRXQXZ1tBbEsPR89btWHTo91I8y1JgNe9AhPJ-4OIQV_hbgJqWX5fRrlgzkRU';
