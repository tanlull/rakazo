import type { Actor } from "@rakazo/contracts";
import { MAIN_BOT_SPAWN_KEY } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createBotRemoval } from "./bot-removal.js";
import type { RouterDeps } from "./router.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

describe("bot removal", () => {
  it("keeps the main bot", async () => {
    const repos = {
      getBot: async () => ({ id: "bot-1", userId: actor.userId, spawnKey: MAIN_BOT_SPAWN_KEY }),
    } as unknown as ReturnType<typeof createRepos>;
    const removeBot = createBotRemoval({} as RouterDeps, repos);
    await expect(removeBot(actor, "bot-1", { deleteMemories: false })).rejects.toThrow(
      "The main bot can't be deleted.",
    );
  });
});
