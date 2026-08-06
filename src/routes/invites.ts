import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../lib/guards.js";
import { formatInviteCode, generateInviteCode, isValidInviteCode } from "../lib/invite-code.js";
import { prisma } from "../lib/prisma.js";
import { loadUserDTO } from "../lib/serialize.js";

const redeemSchema = z.object({
  code: z.string().trim().min(1),
});

const MAX_GENERATE_ATTEMPTS = 5;

export default async function inviteRoutes(app: FastifyInstance) {
  // Counselors generate codes; students redeem them.
  app.post(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request, reply) => {
      for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
        const code = generateInviteCode();
        try {
          const invite = await prisma.inviteCode.create({
            data: { code, counselorId: request.user.sub },
          });
          return reply.code(201).send({ code: invite.code, createdAt: invite.createdAt });
        } catch (err) {
          // Unique constraint collision on `code` — vanishingly rare, just retry.
          const isCollision = (err as { code?: string }).code === "P2002";
          if (!isCollision) throw err;
        }
      }
      return reply.code(500).send({ error: "Could not generate a unique invite code, try again" });
    }
  );

  app.get(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request, reply) => {
      const invites = await prisma.inviteCode.findMany({
        where: { counselorId: request.user.sub },
        orderBy: { createdAt: "desc" },
        include: { redeemedBy: { select: { id: true, fullName: true, email: true } } },
      });
      return reply.send({
        invites: invites.map((invite) => ({
          code: invite.code,
          createdAt: invite.createdAt,
          redeemedAt: invite.redeemedAt,
          redeemedBy: invite.redeemedBy,
        })),
      });
    }
  );

  app.post(
    "/redeem",
    { preHandler: [app.authenticate, requireRole("student")] },
    async (request, reply) => {
      const body = redeemSchema.parse(request.body);

      if (!isValidInviteCode(body.code)) {
        return reply.code(400).send({ error: "That code isn't formatted correctly" });
      }
      const code = formatInviteCode(body.code);

      const invite = await prisma.inviteCode.findUnique({ where: { code } });
      if (!invite) {
        return reply.code(404).send({ error: "That invite code doesn't exist" });
      }
      if (invite.redeemedById) {
        return reply.code(409).send({ error: "That invite code has already been used" });
      }

      await prisma.$transaction([
        prisma.inviteCode.update({
          where: { id: invite.id },
          data: { redeemedById: request.user.sub, redeemedAt: new Date() },
        }),
        prisma.user.update({
          where: { id: request.user.sub },
          data: { counselorId: invite.counselorId },
        }),
      ]);

      const dto = await loadUserDTO(request.user.sub);
      return reply.send({ user: dto });
    }
  );
}
