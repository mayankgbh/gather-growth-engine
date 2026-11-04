import { timingSafeEqual } from "node:crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Dedicated owner-scoped credential. It grants no access to generic app routes. */
export async function getManagedOwner(request: Request): Promise<{ id: string; email: string } | null> {
  const ownerEmail = process.env.MANAGED_OUTREACH_OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail) return null;
  const expected = process.env.MANAGED_OUTREACH_SERVICE_SECRET;
  const supplied = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  const service = !!expected && expected.length >= 32 && !!supplied &&
    Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!service) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email || session.user.email.toLowerCase() !== ownerEmail) return null;
  }
  return prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true, email: true } });
}
