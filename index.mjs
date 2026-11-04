import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

const json = (body) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ephemeral = only the person who ran the command sees it
const reply = (content, ephemeral = false) =>
  json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? 64 : 0,
      allowed_mentions: { parse: [] },
    },
  });

const isOrganizer = (i) => {
  const p = BigInt(i.member?.permissions ?? 0);
  return (p & 0x8n) !== 0n || (p & 0x20n) !== 0n; // Administrator or Manage Server
};

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (c) =>
  `**${c.id}** · ${c.name} · ${c.date} · ${c.volunteers?.size ?? 0}/${c.spots} filled`;

async function upcoming() {
  const { Items = [] } = await db.send(new ScanCommand({ TableName: TABLE }));
  return Items.filter((c) => c.date >= today()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

const actions = {
  async add(i, opts) {
    if (!isOrganizer(i)) return reply("Only organizers can add chores.", true);
    const { name, date, spots = 1 } = opts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      return reply(
        "Please use the date format YYYY-MM-DD, e.g. 2026-11-20.",
        true,
      );
    }
    const id = randomBytes(2).toString("hex");
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id, name, date, spots },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return reply(
      `✅ Added **${name}** on ${date} (${spots} spot${spots > 1 ? "s" : ""}). ID: \`${id}\``,
    );
  },

  async list() {
    const chores = await upcoming();
    if (!chores.length) return reply("No upcoming chores right now. 🎉");
    return reply("**Upcoming chores**\n" + chores.map(fmt).join("\n"));
  },

  async signup(i, opts, userId) {
    const { Item: c } = await db.send(
      new GetCommand({ TableName: TABLE, Key: { id: opts.id } }),
    );
    if (!c) return reply("I can't find a chore with that ID.", true);
    if (c.volunteers?.has(userId))
      return reply("You're already signed up for that one.", true);
    if ((c.volunteers?.size ?? 0) >= c.spots)
      return reply("Sorry, that chore is already full.", true);
    try {
      await db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: c.id },
          UpdateExpression: "ADD volunteers :u",
          ConditionExpression:
            "NOT contains(volunteers, :uid) AND (attribute_not_exists(volunteers) OR size(volunteers) < spots)",
          ExpressionAttributeValues: {
            ":u": new Set([userId]),
            ":uid": userId,
          },
        }),
      );
    } catch (e) {
      if (e.name === "ConditionalCheckFailedException")
        return reply("Someone just took the last spot!", true);
      throw e;
    }
    return reply(`🙌 <@${userId}> signed up for **${c.name}** on ${c.date}.`);
  },

  async drop(i, opts, userId) {
    const { Item: c } = await db.send(
      new GetCommand({ TableName: TABLE, Key: { id: opts.id } }),
    );
    if (!c) return reply("I can't find a chore with that ID.", true);
    if (!c.volunteers?.has(userId))
      return reply("You're not signed up for that chore.", true);
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: c.id },
        UpdateExpression: "DELETE volunteers :u",
        ExpressionAttributeValues: { ":u": new Set([userId]) },
      }),
    );
    return reply(
      `👋 <@${userId}> dropped **${c.name}** on ${c.date}. A spot is open again!`,
    );
  },

  async mine(i, opts, userId) {
    const mine = (await upcoming()).filter((c) => c.volunteers?.has(userId));
    if (!mine.length) return reply("You have no upcoming chores.", true);
    return reply("**Your chores**\n" + mine.map(fmt).join("\n"), true);
  },

  async remove(i, opts) {
    if (!isOrganizer(i))
      return reply("Only organizers can remove chores.", true);
    await db.send(
      new DeleteCommand({ TableName: TABLE, Key: { id: opts.id } }),
    );
    return reply(`🗑️ Removed chore \`${opts.id}\` (if it existed).`);
  },
};

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
    try {
      const { name, options } = interaction.data;

      if (name === "ping") return reply("Pong!");

      if (name === "chores") {
        const sub = options[0];
        const opts = Object.fromEntries(
          (sub.options ?? []).map((o) => [o.name, o.value]),
        );
        const userId = interaction.member?.user?.id ?? interaction.user?.id;
        const action = actions[sub.name];
        if (action) return await action(interaction, opts, userId);
      }

      return reply("Unknown command.", true);
    } catch (err) {
      console.error(err);
      return reply("Something went wrong. Please try again.", true);
    }
  }

  return { statusCode: 400, body: "unhandled interaction type" };
};

// TEsting
