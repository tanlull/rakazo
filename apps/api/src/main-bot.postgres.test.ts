import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { MAIN_BOT_NAME, MAIN_BOT_SPAWN_KEY } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureMainBot } from "./main-bot.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("the built-in main bot (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let sequence = 0;

  async function signup(): Promise<Actor> {
    const userId = `main-bot-${++sequence}-${suffix}`;
    users.push(userId);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  // As the bootstrap route runs it: limited to the caller's Space by row-level security.
  const ensure = (actor: Actor) =>
    runAsTenant(actor, () => ensureMainBot({ prisma: db.prisma }, createRepos(db.prisma), actor));

  const mainBots = (spaceId: string) =>
    system.bot.findMany({ where: { spaceId, spawnKey: MAIN_BOT_SPAWN_KEY } });

  beforeAll(() => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("leaves an empty space to onboarding", async () => {
    const actor = await signup();
    await ensure(actor);
    expect(await mainBots(actor.spaceId)).toHaveLength(0);
  });

  it("adds one main bot to a personal space that has other bots", async () => {
    const actor = await signup();
    await system.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Scout", color: "blue" },
    });
    await Promise.all([ensure(actor), ensure(actor)]);
    await ensure(actor);
    const created = await mainBots(actor.spaceId);
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe(MAIN_BOT_NAME);
    expect(created[0]?.userId).toBe(actor.userId);
  });
});
