import type { Actor } from "@rakazo/contracts";
import { MAIN_BOT_INSTRUCTIONS, MAIN_BOT_NAME, MAIN_BOT_SPAWN_KEY } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/**
 * Gives a personal space that already has bots its built-in main bot. An empty space
 * gets it from onboarding instead, which also runs its introduction. A shared space
 * gets none: whoever opened it first would own everyone's coordinator.
 */
export async function ensureMainBot(
  deps: Pick<RouterDeps, "prisma">,
  repos: Pick<ReturnType<typeof createRepos>, "createBot">,
  actor: Actor,
): Promise<void> {
  const space = await deps.prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: {
      isDefault: true,
      _count: { select: { bots: true, memberships: true } },
      bots: { where: { spawnKey: MAIN_BOT_SPAWN_KEY }, select: { id: true }, take: 1 },
    },
  });
  if (
    !space?.isDefault ||
    space._count.memberships !== 1 ||
    space._count.bots === 0 ||
    space.bots.length > 0
  )
    return;
  // The spawn key makes a concurrent create return the same bot.
  await repos.createBot(actor, {
    name: MAIN_BOT_NAME,
    description: "",
    instructions: MAIN_BOT_INSTRUCTIONS,
    notifyOnFinish: true,
    spawnKey: MAIN_BOT_SPAWN_KEY,
  });
}
