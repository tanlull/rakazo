/**
 * Every personal space has one built-in bot that coordinates the user's other bots.
 * Its spawn key predates the name, so accounts created earlier keep their first bot.
 */
export const MAIN_BOT_SPAWN_KEY = "onboarding:first";
export const MAIN_BOT_NAME = "Main Bot";
export const MAIN_BOT_INSTRUCTIONS =
  "You are the user's main bot. Handle a request yourself when you can. When it fits one of the user's other bots better, or needs several of them, hand each part to the right teammate, follow it through, and report the combined result here.";

export function isMainBot(bot: { spawnKey?: string | null }): boolean {
  return bot.spawnKey === MAIN_BOT_SPAWN_KEY;
}
