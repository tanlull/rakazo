import { isMainBot, MAIN_BOT_SPAWN_KEY } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** Most bots a directory lists from other Spaces, matching the same-space roster. */
const CROSS_SPACE_TEAMMATE_LIMIT = 50;

type CrossSpaceSender = {
  userId: string;
  spawnKey: string | null;
  crossSpaceCommunication: boolean;
};

/**
 * Bots in their owner's other Spaces that a bot may message. The main bot reaches
 * every one of them, and each of them reaches the main bot to answer it. Only the
 * owner's own run crosses Spaces, both bots must allow cross-space communication,
 * and the owner must still belong to the target's Space.
 */
export async function crossSpaceTeammates(
  prisma: Pick<PrismaClient, "bot">,
  run: { spaceId: string; userId: string },
  senderOrId: CrossSpaceSender | string,
) {
  const sender =
    typeof senderOrId === "string"
      ? await prisma.bot.findUnique({
          where: { id: senderOrId },
          select: { userId: true, spawnKey: true, crossSpaceCommunication: true },
        })
      : senderOrId;
  if (!sender?.crossSpaceCommunication || sender.userId !== run.userId) return [];
  const bots = await prisma.bot.findMany({
    where: {
      userId: sender.userId,
      spaceId: { not: run.spaceId },
      archivedAt: null,
      crossSpaceCommunication: true,
      thread: { isNot: null },
      ...(isMainBot(sender) ? {} : { spawnKey: MAIN_BOT_SPAWN_KEY }),
      space: { deletingAt: null, memberships: { some: { userId: sender.userId } } },
    },
    select: {
      id: true,
      name: true,
      description: true,
      spaceId: true,
      space: { select: { name: true } },
      thread: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: CROSS_SPACE_TEAMMATE_LIMIT,
  });
  return bots.map(({ space, ...bot }) => ({ ...bot, spaceName: space.name }));
}
