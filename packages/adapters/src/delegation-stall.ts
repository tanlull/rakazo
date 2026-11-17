import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  buildDelegationStallWakePrompt,
  delegationStallMinutes,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  isUniqueViolation,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { loadDelegatedWakeContext } from "./delegation-context.js";

/** How far behind `DELEGATION_STALL_MINUTES` a finished step is still eligible. */
const LOOKBACK_MS = 12 * 60 * 60 * 1000;
const NONCE_PREFIX = "delegation-stall";

function stallNonce(runId: string): string {
  return `${NONCE_PREFIX}:${runId}`;
}

function asBlocks(value: unknown): MessageBlock[] {
  return Array.isArray(value) ? (value as MessageBlock[]) : [];
}

/** The peer result or status that woke this coordinator run, when that is what it is. */
function delegatedCompletion(
  blocks: unknown,
): { text: string; returnToMessageId?: string } | undefined {
  const received = asBlocks(blocks).find(
    (block): block is Extract<MessageBlock, { kind: "bot_message_received" }> =>
      block.kind === "bot_message_received",
  );
  if (!received || (received.intent !== "result" && received.intent !== "status")) return undefined;
  return {
    text: received.text,
    ...(received.returnToMessageId ? { returnToMessageId: received.returnToMessageId } : {}),
  };
}

/** True when this run already dispatched another request or question. */
async function sentFollowUp(prisma: PrismaClient, runId: string): Promise<boolean> {
  const messages = await prisma.message.findMany({
    where: { runId },
    select: { blocks: true },
  });
  return messages.some((message) =>
    asBlocks(message.blocks).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    ),
  );
}

/** True when the thread already moved on, or a run is in progress there. */
async function threadMovedOn(
  db: PrismaClient | Prisma.TransactionClient,
  threadId: string,
  runId: string,
  completedAt: Date,
): Promise<boolean> {
  const [newer, active] = await Promise.all([
    db.run.findFirst({
      where: { threadId, id: { not: runId }, createdAt: { gt: completedAt } },
      select: { id: true },
    }),
    db.run.findFirst({
      where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
  ]);
  return Boolean(newer || active);
}

/**
 * Re-wake a coordinator whose delegated step finished, whose open scratchpad
 * plan was not continued, and which sent no follow-up. Off unless
 * `DELEGATION_STALL_MINUTES` is a positive integer. One wake per stalled run.
 */
export async function reconcileDelegationStalls(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now: Date;
  batchSize: number;
}): Promise<number> {
  const minutes = delegationStallMinutes();
  if (minutes < 1) return 0;
  const dueBefore = new Date(deps.now.getTime() - minutes * 60_000);
  const windowStart = new Date(dueBefore.getTime() - LOOKBACK_MS);
  const candidates = await deps.prisma.run.findMany({
    where: {
      trigger: "bot_message",
      status: "completed",
      completedAt: { lte: dueBefore, gte: windowStart },
      sourceMessageId: { not: null },
      OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: `${NONCE_PREFIX}:` } } }],
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      completedAt: true,
      sourceMessage: { select: { blocks: true } },
    },
  });

  let woken = 0;
  for (const candidate of candidates) {
    if (!candidate.completedAt) continue;
    const completion = delegatedCompletion(candidate.sourceMessage?.blocks);
    if (!completion) continue;
    if (await sentFollowUp(deps.prisma, candidate.id)) continue;
    if (await threadMovedOn(deps.prisma, candidate.threadId, candidate.id, candidate.completedAt)) {
      continue;
    }
    const openPlan = await deps.prisma.scratchpadItem.findFirst({
      where: {
        spaceId: candidate.spaceId,
        botId: candidate.botId,
        status: { in: ["open", "parked"] },
      },
      select: { id: true },
    });
    if (!openPlan) continue;
    const context = await loadDelegatedWakeContext(deps.prisma, {
      spaceId: candidate.spaceId,
      botId: candidate.botId,
      threadId: candidate.threadId,
      returnToMessageId: completion.returnToMessageId,
    }).catch((error: unknown) => {
      getLogger().warn("delegation stall context", { error });
      return undefined;
    });
    if (!context?.plan?.trim()) continue;
    const queued = await queueStallWake(deps, candidate, {
      ...context,
      lastResult: completion.text,
    }).catch((error: unknown) => {
      getLogger().error("delegation stall wake", error);
      return false;
    });
    if (queued) woken += 1;
  }
  return woken;
}

async function queueStallWake(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  candidate: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    completedAt: Date | null;
  },
  context: Parameters<typeof buildDelegationStallWakePrompt>[0],
): Promise<boolean> {
  const nonce = stallNonce(candidate.id);
  const prompt = buildDelegationStallWakePrompt(context);
  const completedAt = candidate.completedAt ?? new Date(0);
  let runId: string | undefined;
  try {
    runId = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (!(await spaceTakesWork(tx, candidate.spaceId))) return undefined;
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
        const bot = await tx.bot.findFirst({
          where: { id: candidate.botId, spaceId: candidate.spaceId, archivedAt: null },
          select: { id: true, thread: { select: { id: true } } },
        });
        if (!bot?.thread || bot.thread.id !== candidate.threadId) return undefined;
        const stillOpen = await tx.scratchpadItem.findFirst({
          where: {
            spaceId: candidate.spaceId,
            botId: candidate.botId,
            status: { in: ["open", "parked"] },
          },
          select: { id: true },
        });
        if (!stillOpen) return undefined;
        if (await threadMovedOn(tx, candidate.threadId, candidate.id, completedAt)) {
          return undefined;
        }
        const existing = await tx.run.findFirst({
          where: { spaceId: candidate.spaceId, clientNonce: nonce },
          select: { id: true },
        });
        if (existing) return undefined;
        const task = await tx.task.create({
          data: {
            spaceId: candidate.spaceId,
            botId: candidate.botId,
            threadId: candidate.threadId,
            userId: candidate.userId,
            prompt,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: candidate.spaceId,
            botId: candidate.botId,
            threadId: candidate.threadId,
            taskId: task.id,
            userId: candidate.userId,
            status: "queued",
            trigger: "bot_message",
            clientNonce: nonce,
          },
          select: { id: true },
        });
        return run.id;
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  if (!runId) return false;
  await deps.jobs.enqueue(runContinueJob(runId)).catch((error: unknown) => {
    getLogger().error("delegation stall enqueue", error);
  });
  return true;
}
