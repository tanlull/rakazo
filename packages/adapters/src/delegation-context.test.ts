import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadDelegatedWakeContext } from "./delegation-context.js";

describe("loadDelegatedWakeContext", () => {
  it("walks back to the user's request and keeps delegated steps oldest first", async () => {
    const messages = [
      {
        id: "sent-2",
        role: "bot",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "worker",
            toBotName: "Worker",
            text: "Frames 3-4.",
            intent: "request",
          },
        ],
        runId: "run-2",
        replyToMessageId: null,
      },
      {
        id: "result-1",
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "worker",
            fromBotName: "Worker",
            text: "Frames 1-2 are ready.",
            intent: "result",
          },
        ],
        runId: "worker-run",
        replyToMessageId: "sent-1",
      },
      {
        id: "sent-1",
        role: "bot",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "worker",
            toBotName: "Worker",
            text: "Frames 1-2. Wait for the next batch.",
            intent: "request",
          },
        ],
        runId: "run-1",
        replyToMessageId: null,
      },
      {
        id: "user-1",
        role: "user",
        blocks: [{ kind: "text", text: "Draw 11 frames, two at a time." }],
        runId: null,
        replyToMessageId: null,
      },
    ];
    const prisma = {
      message: { findMany: vi.fn(async () => messages) },
      run: {
        findMany: vi.fn(async () => [
          { id: "run-2", sourceMessageId: "result-1" },
          { id: "run-1", sourceMessageId: "user-1" },
        ]),
      },
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "todo-1",
            botId: "bot-1",
            title: "Frames 5-11",
            status: "open",
            notes: "after batch 2",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ]),
      },
    } as unknown as PrismaClient;

    const context = await loadDelegatedWakeContext(prisma, {
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      returnToMessageId: "sent-2",
    });

    expect(context?.originalRequest).toBe("Draw 11 frames, two at a time.");
    expect(context?.delegatedSteps).toBe("1. Frames 1-2. Wait for the next batch.\n2. Frames 3-4.");
    expect(context?.plan).toContain("[open] Frames 5-11");
    expect(context?.plan).toContain("after batch 2");
  });

  it("returns nothing when the thread and scratchpad are empty", async () => {
    const prisma = {
      message: { findMany: vi.fn(async () => []) },
      run: { findMany: vi.fn() },
      scratchpadItem: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    expect(
      await loadDelegatedWakeContext(prisma, {
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
      }),
    ).toBeUndefined();
    expect(prisma.run.findMany).not.toHaveBeenCalled();
  });
});
