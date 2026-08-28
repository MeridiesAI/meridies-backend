import "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "../lib/serialize.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Set by the supabaseAuth plugin on authenticated routes. */
    auth: { userId: string; email?: string; token: string };
    /** Supabase client bound to the caller's JWT, so RLS applies to every query. */
    db: SupabaseClient;
    /** The caller's own profiles row. */
    profile: Profile;
  }
}
