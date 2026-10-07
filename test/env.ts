// Loaded before every unit test (--import): the env schema needs these at
// import time. Placeholders only; unit tests never reach the network.
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key-000000000000";
process.env.APP_URL ??= "http://localhost:3000";
