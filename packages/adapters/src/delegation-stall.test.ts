import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileDelegationStalls } from "./delegation-stall.js";

afterEach(() => vi.unstubAllEnvs());

const now = new Date("2026-01-01T00:20:00Z");
const completedAt = new Date("2026-01-01T00:00:00Z");

function resultBlocks(intent: "result" | "status" | "request" = "result") {
  return [
    {
      kind: "bot_message_received",
      fromBotId: "worker",
      fromBotName: "Worker",
      text: "Frames 1-2 are ready.",
      intent,
      returnToMessageId: "sent-1",
    },
  ];
}

function harness(
  options: {
    candidates?: unknown[];
    runMessages?: unknown[];
    scratchpad?: unknown[];
    newer?: unknown;
    active?: unknown;
    existing?: unknown;
    deleting?: boolean;
  } = {},
) {
  const enqueue = vi.fn(async () => undefined);
  const scratchpad = options.scratchpad ?? [
    {
      id: "todo-1",
      botId: "bot-1",
      title: "Frames 3-11",
      status: "open",
      notes: "",
      createdAt: completedAt,
      updatedAt: completedAt,
    },
  ];
  const prisma = {
    run: {
      findMany: vi.fn(async (args?: { where?: { id?: unknown } }) => {
        if (args?.where?.id) return [{ id: "coord-1", sourceMessageId: "user-1" }];
        return (
          options.candidates ?? [
            {
              id: "run-1",
              spaceId: "space-1",
              threadId: "thread-1",
              botId: "bot-1",
              userId: "user-1",
              completedAt,
              sourceMessage: { blocks: resultBlocks() },
            },
          ]
        );
      }),
      findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        if ("clientNonce" in where) return options.existing ?? null;
        if ("status" in where) return options.active ?? null;
        if ("createdAt" in where) return options.newer ?? null;
        return null;
      }),
      create: vi.fn(async () => ({ id: "stall-run" })),
    },
    message: {
      findMany: vi.fn(async (args?: { where?: { runId?: string } }) => {
        if (args?.where?.runId) return options.runMessages ?? [];
        return [
          {
            id: "sent-1",
            role: "bot",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "worker",
                toBotName: "Worker",
                text: "Frames 1-2.",
                intent: "request",
              },
            ],
            runId: "coord-1",
            replyToMessageId: null,
          },
          {
            id: "user-1",
            role: "user",
            blocks: [{ kind: "text", text: "Draw 11 frames." }],
            runId: null,
            replyToMessageId: null,
          },
        ];
      }),
    },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpad),
      findFirst: vi.fn(async () => (scratchpad.length ? { id: "todo-1" } : null)),
    },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    space: { findUnique: vi.fn(async () => ({ deletingAt: options.deleting ? now : null })) },
    task: {
      create: vi.fn(async (input: { data: { prompt: string } }) => {
        void input;
        return { id: "task-stall" };
      }),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue, cancel: async () => undefined, close: async () => undefined } as JobPublisher,
    enqueue,
    task: prisma.task,
    run: prisma.run,
  };
}

describe("reconcileDelegationStalls", () => {
  it("does nothing while the safeguard is off", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", undefined);
    const { prisma, jobs, enqueue } = harness();
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(0);
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-wakes a coordinator that stopped with an open plan", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const { prisma, jobs, enqueue, task, run } = harness();
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(1);
    const prompt = task.create.mock.calls[0]?.[0].data.prompt ?? "";
    expect(prompt).toContain("A delegated step finished and no next step was sent.");
    expect(prompt).toContain("Draw 11 frames.");
    expect(prompt).toContain("Frames 3-11");
    expect(prompt).toContain("Frames 1-2 are ready.");
    expect(run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "bot_message",
          clientNonce: "delegation-stall:run-1",
          status: "queued",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("leaves a one-shot result alone when there is no open plan", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const { prisma, jobs, enqueue } = harness({ scratchpad: [] });
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not re-wake a coordinator that already sent the next step", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const { prisma, jobs, enqueue } = harness({
      runMessages: [
        {
          blocks: [
            {
              kind: "bot_message_sent",
              toBotId: "worker",
              toBotName: "Worker",
              text: "Frames 3-4.",
              intent: "request",
            },
          ],
        },
      ],
    });
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not re-wake when the thread already continued or a run is active", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const moved = harness({ newer: { id: "later" } });
    expect(
      await reconcileDelegationStalls({
        prisma: moved.prisma,
        jobs: moved.jobs,
        now,
        batchSize: 20,
      }),
    ).toBe(0);
    const busy = harness({ active: { id: "busy" } });
    expect(
      await reconcileDelegationStalls({ prisma: busy.prisma, jobs: busy.jobs, now, batchSize: 20 }),
    ).toBe(0);
  });

  it("does not wake twice for the same stalled run", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const { prisma, jobs, enqueue, run } = harness({ existing: { id: "stall-run" } });
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(0);
    expect(run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ignores a wake that was not a delegated result", async () => {
    vi.stubEnv("DELEGATION_STALL_MINUTES", "10");
    const { prisma, jobs, enqueue } = harness({
      candidates: [
        {
          id: "run-1",
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          completedAt,
          sourceMessage: { blocks: resultBlocks("request") },
        },
      ],
    });
    expect(await reconcileDelegationStalls({ prisma, jobs, now, batchSize: 20 })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
