import { randomBytes } from "node:crypto";
import { MAIN_BOT_SPAWN_KEY } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createSpaceForMember } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crossSpaceTeammates } from "./cross-space-teammates.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("bots a main bot reaches in other Spaces (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let sequence = 0;

  async function signup() {
    const userId = `cross-space-${++sequence}-${suffix}`;
    users.push(userId);
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId };
  }

  const bot = (
    spaceId: string,
    userId: string,
    name: string,
    data: { spawnKey?: string; crossSpaceCommunication?: boolean; archivedAt?: Date } = {},
  ) =>
    system.bot.create({
      data: {
        spaceId,
        userId,
        name,
        color: "ink",
        ...data,
        thread: { create: { spaceId, userId } },
      },
    });

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

  it("lists the owner's reachable bots for the main bot, and only the main bot for the rest", async () => {
    const owner = await signup();
    const other = await signup();
    const clip = await createSpaceForMember(system, {
      currentSpaceId: owner.spaceId,
      userId: owner.userId,
      name: "Clip",
    });
    const main = await bot(owner.spaceId, owner.userId, "Main Bot", {
      spawnKey: MAIN_BOT_SPAWN_KEY,
    });
    await bot(owner.spaceId, owner.userId, "Same Space");
    const writer = await bot(clip.id, owner.userId, "Writer");
    await bot(clip.id, owner.userId, "Private", { crossSpaceCommunication: false });
    await bot(clip.id, owner.userId, "Retired", { archivedAt: new Date() });
    await bot(other.spaceId, other.userId, "Stranger");

    const run = { spaceId: owner.spaceId, userId: owner.userId };
    const fromMain = await crossSpaceTeammates(system, run, main.id);
    expect(fromMain.map((teammate) => teammate.name)).toEqual(["Writer"]);
    expect(fromMain[0]).toMatchObject({ spaceId: clip.id, spaceName: "Clip" });

    const fromWriter = await crossSpaceTeammates(
      system,
      { spaceId: clip.id, userId: owner.userId },
      writer.id,
    );
    expect(fromWriter.map((teammate) => teammate.id)).toEqual([main.id]);

    // A run another person started never crosses Spaces.
    await expect(
      crossSpaceTeammates(system, { ...run, userId: other.userId }, main.id),
    ).resolves.toEqual([]);

    await system.space.update({ where: { id: clip.id }, data: { deletingAt: new Date() } });
    await expect(crossSpaceTeammates(system, run, main.id)).resolves.toEqual([]);
  });
});
