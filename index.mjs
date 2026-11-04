import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";

const json = (body) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const headers = Object.fromEntries(
    Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  const valid = await verifyKey(
    body,
    headers["x-signature-ed25519"],
    headers["x-signature-timestamp"],
    process.env.DISCORD_PUBLIC_KEY,
  );
  if (!valid) return { statusCode: 401, body: "invalid request signature" };

  const interaction = JSON.parse(body);

  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const reply = (content) =>
      json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content },
      });

    switch (interaction.data.name) {
      case "ping":
        return reply("Pong!");
      case "hello": {
        const userId = interaction.data.options?.[0]?.value;
        return reply(userId ? `Hello <@${userId}>! 👋` : "Hello! 👋");
      }
      default:
        return reply("Unknown command.");
    }
  }

  return { statusCode: 400, body: "unhandled interaction type" };
};
