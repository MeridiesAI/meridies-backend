import type { FastifyReply, FastifyRequest } from "fastify";

/** preHandler that rejects requests unless the authenticated user has `role`. */
export function requireRole(role: "student" | "counselor") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user.role !== role) {
      reply.code(403).send({ error: `Only ${role}s can access this resource` });
    }
  };
}
