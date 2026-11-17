import { describe, expect, it } from "vitest";
import { ownerContentHistory } from "./run-context.js";
import { ownerRoutinePrompt } from "./run-routines.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const runOptions = {
  graphicalToolsAllowed: false,
  groupId: null,
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
  fleetManagement: true,
};

function offered(options: { trigger: string; ownerRoutineRun?: boolean }) {
  return selectBuiltinToolsForRun({ ...runOptions, ...options }).map((tool) => tool.name);
}

describe("bot management tools in routine runs", () => {
  it("are offered to a routine run whose prompt its owner wrote", () => {
    const names = offered({ trigger: "routine", ownerRoutineRun: true });
    expect(names).toContain("list_fleet");
    expect(names).toContain("set_child_instructions");
    expect(names).toContain("create_child_routine");
  });

  it("are not offered to other routine or webhook runs", () => {
    expect(offered({ trigger: "routine" })).not.toContain("list_fleet");
    expect(offered({ trigger: "webhook" })).not.toContain("list_fleet");
  });
});

describe("ownerRoutinePrompt", () => {
  const routine = { promptByOwner: true, userId: "user-1" };

  it("holds for the owner's own prompt without a watch note", () => {
    expect(ownerRoutinePrompt(routine, "user-1", false)).toBe(true);
  });

  it("fails for a bot-written prompt, another person, or a watch's outside note", () => {
    expect(ownerRoutinePrompt({ ...routine, promptByOwner: false }, "user-1", false)).toBe(false);
    expect(ownerRoutinePrompt(routine, "user-2", false)).toBe(false);
    expect(ownerRoutinePrompt(routine, "user-1", true)).toBe(false);
  });
});

const PAST_CHECKS = "reached the bot management preparation";
// Only the reads the checks make; any later read means the call got past them.
const prisma = new Proxy(
  {
    bot: { findUnique: async () => ({ fleetManagement: true }) },
    steeringMessage: { findFirst: async () => null },
  } as Record<string, unknown>,
  {
    get: (known, model: string) =>
      known[model] ??
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error(PAST_CHECKS);
          },
        },
      ),
  },
);

function fleetCall(
  name: string,
  options: {
    ownerRoutineRun: boolean;
    outsideContent?: boolean;
    outsideMessage?: boolean;
    earlierAttempt?: boolean;
  },
) {
  const ctx = {
    deps: { prisma },
    runId: "run-1",
    run: { trigger: "routine", threadId: "thread-1" },
    bot: { id: "bot-1" },
    source: { ownerStartedRun: false, ownerRoutineRun: options.ownerRoutineRun },
    // A routine run starts tainted because nobody started it; only outside content blocks it.
    state: {
      tainted: true,
      outsideContent: Boolean(options.outsideContent),
      earlierAttempt: Promise.resolve(Boolean(options.earlierAttempt)),
    },
    trust: {
      // Never ask: no approval mode lifts the block on an unattended run.
      loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: true }),
      receivedOutsideMessage: async () => Boolean(options.outsideMessage),
    },
    secrets: [],
  };
  const request = {
    name,
    args: { bot_id: "bot-2", expected_version: 1, instructions: "Report daily." },
    executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
    nextApprovedTool: undefined,
  } as unknown as ToolRequest;
  return prepareToolRequest(ctx as never, request);
}

const blocked = { error: expect.stringContaining("read outside content") };

describe("bot management changes in an owner-written routine run", () => {
  it("refuse a routine run whose prompt is not the owner's", async () => {
    await expect(fleetCall("list_fleet", { ownerRoutineRun: false })).resolves.toMatchObject({
      error: expect.stringContaining("need a run you started"),
    });
  });

  it("let it read the fleet before and after outside content", async () => {
    await expect(fleetCall("list_fleet", { ownerRoutineRun: true })).resolves.toBeUndefined();
    await expect(
      fleetCall("list_fleet", { ownerRoutineRun: true, outsideContent: true }),
    ).resolves.toBeUndefined();
  });

  it("let it change bots before outside content", async () => {
    await expect(fleetCall("set_child_instructions", { ownerRoutineRun: true })).rejects.toThrow(
      PAST_CHECKS,
    );
  });

  it("block changes after a tool result, an outside message or a restored attempt", async () => {
    for (const entered of [
      { outsideContent: true },
      { outsideMessage: true },
      { earlierAttempt: true },
    ]) {
      await expect(
        fleetCall("set_child_instructions", { ownerRoutineRun: true, ...entered }),
      ).resolves.toMatchObject(blocked);
    }
  });
});

describe("a routine run's earlier thread", () => {
  const run = { id: "run-now", userId: "user-1" };
  const cleanRuns = new Set(["run-clean"]);
  const quoted = new Map<string, Message>();
  type Message = {
    id: string;
    role: string;
    runId: string | null;
    authorUserId: string | null;
    replyToMessageId: string | null;
  };
  const db = {
    run: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => cleanRuns.has(id)).map((id) => ({ id })),
    },
    message: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (quoted.has(id) ? [quoted.get(id)] : [])),
    },
  } as unknown as Parameters<typeof ownerContentHistory>[0];
  const message = (fields: Partial<Message>): Message => ({
    id: "m-1",
    role: "user",
    runId: null,
    authorUserId: "user-1",
    replyToMessageId: null,
    ...fields,
  });

  it("is the owner's when only they and their clean runs wrote it", async () => {
    await expect(
      ownerContentHistory(db, run, [
        message({}),
        message({ id: "m-2", role: "bot", runId: "run-clean", authorUserId: null }),
        message({ id: "m-3", role: "bot", runId: "run-now", authorUserId: null }),
      ]),
    ).resolves.toBe(true);
  });

  it("is outside content when a reply came from a run that read some", async () => {
    await expect(
      ownerContentHistory(db, run, [
        message({ role: "bot", runId: "run-read-web", authorUserId: null }),
      ]),
    ).resolves.toBe(false);
  });

  it("is outside content with another person's or a system message", async () => {
    await expect(ownerContentHistory(db, run, [message({ authorUserId: "user-2" })])).resolves.toBe(
      false,
    );
    await expect(
      ownerContentHistory(db, run, [message({ role: "system", authorUserId: null })]),
    ).resolves.toBe(false);
  });

  it("checks a quoted message outside the window too", async () => {
    quoted.set("old", message({ id: "old", role: "user", authorUserId: "user-2" }));
    await expect(
      ownerContentHistory(db, run, [message({ replyToMessageId: "old" })]),
    ).resolves.toBe(false);
  });
});
