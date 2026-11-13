import { describe, expect, it } from "vitest";
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
