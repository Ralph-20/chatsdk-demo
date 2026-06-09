import { after } from "next/server";
import { getBot } from "@/lib/bot";

export async function POST(
  request: Request,
  context: RouteContext<"/api/webhooks/[platform]">,
) {
  const { platform } = await context.params;
  const bot = getBot();
  const handler = bot.webhooks[platform as keyof typeof bot.webhooks];
  if (!handler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }
  return handler(request, { waitUntil: (task) => after(() => task) });
}

export const maxDuration = 300;
