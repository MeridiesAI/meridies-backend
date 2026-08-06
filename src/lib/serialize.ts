import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

const userWithLinksArgs = {
  include: {
    invitesGenerated: { orderBy: { createdAt: "desc" as const }, take: 1 },
    redeemedInvite: { include: { counselor: true } },
  },
} satisfies Prisma.UserDefaultArgs;

type UserWithLinks = Prisma.UserGetPayload<typeof userWithLinksArgs>;

/**
 * Shape mirrors `MeridiesUser` in meridies-app/lib/storage.ts so the client
 * can swap localStorage for this API without changing its data model.
 */
export type UserDTO = {
  id: string;
  fullName: string;
  email: string;
  role: "student" | "counselor";
  onboardingStep: number;
  onboardingComplete: boolean;
  inviteCode?: string;
  counselorName?: string;
  profile?: Record<string, unknown>;
};

function serializeUser(user: UserWithLinks): UserDTO {
  const inviteCode =
    user.role === "counselor"
      ? user.invitesGenerated[0]?.code
      : user.redeemedInvite?.code;

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    onboardingStep: user.onboardingStep,
    onboardingComplete: user.onboardingComplete,
    inviteCode: inviteCode ?? undefined,
    counselorName: user.redeemedInvite?.counselor.fullName ?? undefined,
    profile: (user.profile as Record<string, unknown> | null) ?? undefined,
  };
}

/** Re-fetch a user with its invite links and return the frontend-shaped DTO. */
export async function loadUserDTO(id: string): Promise<UserDTO | null> {
  const user = await prisma.user.findUnique({ where: { id }, ...userWithLinksArgs });
  if (!user) return null;
  return serializeUser(user);
}
