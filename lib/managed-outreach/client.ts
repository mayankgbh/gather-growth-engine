import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { createManagedInstantlyClient } from "@/lib/managed-outreach/instantly";

/** Server-side only: callers must authorize the owner before loading their key. */
export async function getManagedInstantlyClientForUserId(
  userId: string,
  options: { timeoutMs?: number; maxPages?: number } = {},
) {
  const workspace = await prisma.workspace.findUnique({
    where: { userId },
    select: { instantlyKey: true },
  });
  if (!workspace?.instantlyKey) return null;
  // Neither the decrypted key nor provider error bodies leave this adapter.
  return createManagedInstantlyClient(decrypt(workspace.instantlyKey), options);
}
