import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { loadUserDTO } from "../lib/serialize.js";

const BCRYPT_ROUNDS = 12;

const signupSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["student", "counselor"]),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    onboardingStep: z.number().int().min(0),
    onboardingComplete: z.boolean(),
    profile: z.record(z.unknown()),
  })
  .partial();

export default async function authRoutes(app: FastifyInstance) {
  app.post("/signup", async (request, reply) => {
    const body = signupSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.code(409).send({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        fullName: body.fullName,
        email: body.email,
        passwordHash,
        role: body.role,
      },
    });

    const token = app.jwt.sign({ sub: user.id, role: user.role });
    const dto = await loadUserDTO(user.id);
    return reply.code(201).send({ user: dto, token });
  });

  app.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const token = app.jwt.sign({ sub: user.id, role: user.role });
    const dto = await loadUserDTO(user.id);
    return reply.send({ user: dto, token });
  });

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const dto = await loadUserDTO(request.user.sub);
    if (!dto) return reply.code(404).send({ error: "User not found" });
    return reply.send({ user: dto });
  });

  app.patch("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const patch = updateMeSchema.parse(request.body);

    await prisma.user.update({
      where: { id: request.user.sub },
      data: patch as Record<string, unknown>,
    });

    const dto = await loadUserDTO(request.user.sub);
    return reply.send({ user: dto });
  });
}
