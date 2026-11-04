import "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthProfile } from "../lib/serialize.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyContextConfig {
    /** Open this route to a counselor whose account is not approved yet. Closed by default. */
    allowPending?: boolean;
  }

  interface FastifyRequest {
    /** Set by the supabaseAuth plugin on authenticated routes. */
    auth: { userId: string; email?: string; token: string };
    /** Supabase client bound to the caller's JWT, so RLS applies to every query. */
    db: SupabaseClient;
    /**
     * The caller's own profiles row, without the `profile` jsonb (onboarding
     * answers, up to 300 KB): read that with `loadOwnProfileBlob` where needed.
     */
    profile: AuthProfile;
    /**
     * Set when the request is AxIS running a delete the counselor confirmed (a valid mark, lib/axis/ops/trash.ts):
     * `db` then carries the header the database's trash reads.
     */
    axisActionId?: string;
  }
}
