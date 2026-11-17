import type { MessageBlock } from "@rakazo/contracts";
import type { DelegatedWakeContext } from "@rakazo/core";
import { truncatePlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { listScratchpadItems } from "./scratchpad-tools.js";

/** Recent thread window the coordinator's request and sent steps are read from. */
const THREAD_WINDOW = 80;
const CHAIN_LIMIT = 8;
const STEP_CHARS = 400;
const PLAN_ITEMS = 12;

type ThreadRow = {
  id: string;
  role: string;
  blocks: unknown;
  runId: string | null;
  replyToMessageId: string | null;
};

function asBlocks(value: unknown): MessageBlock[] {
  return Array.isArray(value) ? (value as MessageBlock[]) : [];
}

/** A person's own message. Peer wakes and channel posts are not the original request. */
function humanRequestText(row: ThreadRow): string | undefined {
  if (row.role !== "user") return undefined;
  const blocks = asBlocks(row.blocks);
  if (
    blocks.some(
      (block) =>
        block.kind === "bot_message_received" ||
        block.kind === "channel_message" ||
        block.kind === "handoff",
    )
  ) {
    return undefined;
  }
  const text = blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}

/** A request or question this bot already sent, which is one step of the pipeline. */
function sentStepText(row: ThreadRow): string | undefined {
  const sent = asBlocks(row.blocks).find(
    (block): block is Extract<MessageBlock, { kind: "bot_message_sent" }> =>
      block.kind === "bot_message_sent" &&
      (block.intent === undefined || block.intent === "request" || block.intent === "question"),
  );
  const text = sent?.text.trim();
  return text ? truncatePlainText(text, STEP_CHARS) : undefined;
}

/**
 * The user's request and the steps already delegated, walked from the outbound
 * message this result answers. A later "any update?" in the thread is not the request.
 */
function walkDelegationChain(
  messages: readonly ThreadRow[],
  runs: readonly { id: string; sourceMessageId: string | null }[],
  returnToMessageId: string | undefined,
): { originalRequest?: string; delegatedSteps?: string } {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const sourceByRun = new Map(runs.map((run) => [run.id, run.sourceMessageId]));
  const steps: string[] = [];
  let originalRequest: string | undefined;
  let cursor = returnToMessageId;
  const seen = new Set<string>();
  for (let hop = 0; hop < CHAIN_LIMIT && cursor && !seen.has(cursor); hop += 1) {
    seen.add(cursor);
    const message = byId.get(cursor);
    if (!message) break;
    const step = sentStepText(message);
    if (step) steps.push(step);
    const sourceId = message.runId ? sourceByRun.get(message.runId) : undefined;
    if (!sourceId) break;
    const source = byId.get(sourceId);
    if (!source) break;
    const human = humanRequestText(source);
    if (human) {
      originalRequest = human;
      break;
    }
    cursor = source.replyToMessageId ?? undefined;
  }
  if (!originalRequest) {
    originalRequest = messages.map(humanRequestText).find((text) => text !== undefined);
  }
  steps.reverse();
  return {
    ...(originalRequest ? { originalRequest } : {}),
    ...(steps.length > 0
      ? { delegatedSteps: steps.map((step, index) => `${index + 1}. ${step}`).join("\n") }
      : {}),
  };
}

/**
 * Context for the coordinator a delegated result is waking. Open scratchpad items
 * are the unfinished plan a stall re-wake requires; the result wake still carries
 * the original request and steps already sent when there is no scratchpad.
 */
export async function loadDelegatedWakeContext(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    botId: string;
    threadId: string;
    returnToMessageId?: string;
  },
): Promise<DelegatedWakeContext | undefined> {
  const [messages, items] = await Promise.all([
    prisma.message.findMany({
      where: { threadId: input.threadId },
      orderBy: { seq: "desc" },
      take: THREAD_WINDOW,
      select: { id: true, role: true, blocks: true, runId: true, replyToMessageId: true },
    }),
    listScratchpadItems(
      { prisma },
      { spaceId: input.spaceId, botId: input.botId, includeDone: false },
    ),
  ]);
  const runIds = [
    ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
  ];
  const runs = runIds.length
    ? await prisma.run.findMany({
        where: { id: { in: runIds } },
        select: { id: true, sourceMessageId: true },
      })
    : [];
  const chain = walkDelegationChain(messages, runs, input.returnToMessageId);
  const plan = items
    .slice(0, PLAN_ITEMS)
    .map((item) => {
      const notes = item.notes.trim().replace(/\s+/g, " ");
      const note = notes ? `: ${truncatePlainText(notes, 240)}` : "";
      return `- [${item.status}] ${truncatePlainText(item.title.trim(), 200)}${note}`;
    })
    .join("\n");
  const context: DelegatedWakeContext = {
    ...chain,
    ...(plan ? { plan } : {}),
  };
  if (!context.originalRequest && !context.plan && !context.delegatedSteps) return undefined;
  return context;
}
