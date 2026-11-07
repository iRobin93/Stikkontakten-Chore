// Frivillig-bot for gamingsenter – Lambda-handler (fase 1 + 2)
// Discord kaller denne via Lambda Function URL. EventBridge kaller den for planlagte jobber.

import { verifyKey } from "discord-interactions";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchGetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomBytes, randomUUID } from "node:crypto";

/* ============================================================
 * Oppsett
 * ============================================================ */

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.TABLE_NAME;
const DISCORD_API = "https://discord.com/api/v10";

const SIZES = { small: "Lite", medium: "Middels", large: "Stort" };
const SIZE_SETTING = {
  small: "pointsSmall",
  medium: "pointsMedium",
  large: "pointsLarge",
};

// Standardverdier. Alt kan overstyres i DynamoDB (CONFIG/SETTINGS) via /innstillinger,
// uten ny deploy. Poengverdiene under er plassholdere – sett dine egne.
const DEFAULT_SETTINGS = {
  checkinDays: 2,
  maxActiveTasks: 3, // 0 = ingen grense
  pointsSmall: 10,
  pointsMedium: 25,
  pointsLarge: 50,
  adminChannelId: process.env.ADMIN_CHANNEL_ID ?? null,
  fallbackChannelId: process.env.FALLBACK_CHANNEL_ID ?? null,
  summaryChannelId: process.env.SUMMARY_CHANNEL_ID ?? null,
  meetingPoints: 10, // poeng for oppmøte (plassholder)
  meetingCheckinBeforeMin: 15, // innsjekk åpner så mange minutter før start
  meetingCheckinAfterMin: 180, // og stenger så mange minutter etter start
  untakenAlertDays: 3, // admin-varsel hvis ingen har tatt en oppgave (0 = av)
};

const SETTING_DEFS = {
  checkinDays: { type: "int", min: 1, max: 30, label: "Dager før innsjekk" },
  maxActiveTasks: {
    type: "int",
    min: 0,
    max: 50,
    label: "Maks aktive oppgaver per person (0 = ingen grense)",
  },
  pointsSmall: { type: "int", min: 0, max: 10000, label: "Poeng: lite" },
  pointsMedium: { type: "int", min: 0, max: 10000, label: "Poeng: middels" },
  pointsLarge: { type: "int", min: 0, max: 10000, label: "Poeng: stort" },
  adminChannelId: { type: "id", label: "Admin-kanal (godkjenning)" },
  fallbackChannelId: {
    type: "id",
    label: "Reservekanal hvis DM er stengt (innsjekk)",
  },
  summaryChannelId: { type: "id", label: "Kanal for ukesoppsummering" },
  meetingPoints: {
    type: "int",
    min: 0,
    max: 10000,
    label: "Poeng for møteoppmøte",
  },
  meetingCheckinBeforeMin: {
    type: "int",
    min: 0,
    max: 240,
    label: "Innsjekk åpner (min før møtestart)",
  },
  meetingCheckinAfterMin: {
    type: "int",
    min: 15,
    max: 1440,
    label: "Innsjekk stenger (min etter møtestart)",
  },
  untakenAlertDays: {
    type: "int",
    min: 0,
    max: 60,
    label: "Dager før admin-varsel om utatt oppgave (0 = av)",
  },
};

const NO_ACCESS = "Dette er forbeholdt admin/leder 🙂";
const MAX_LIST = 15; // maks oppgaver/knapper i én melding (Discord tillater 25 knapper)
const INDEXED_STATUSES = new Set(["active", "waitlist", "submitted"]);

/* ============================================================
 * Små hjelpere
 * ============================================================ */

const now = () => new Date().toISOString();
const todayOslo = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" }); // YYYY-MM-DD
const fmtDate = (s) => {
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
};
const discordTime = (iso) => `<t:${Math.floor(Date.parse(iso) / 1000)}:d>`;
const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, k) =>
    arr.slice(k * n, k * n + n),
  );
const userOf = (i) => i.member?.user ?? i.user;

const json = (body) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
// type 4: ny melding. type 7: oppdater meldingen knappen satt på. type 9: modal.
const message = (data) =>
  json({ type: 4, data: { allowed_mentions: { parse: [] }, ...data } });
const ephemeral = (content, extra = {}) =>
  message({ content, flags: 64, ...extra });
const updateMessage = (data) =>
  json({ type: 7, data: { allowed_mentions: { parse: [] }, ...data } });

const button = (style, label, custom_id) => ({
  type: 2,
  style, // 1 primær, 2 sekundær, 3 grønn, 4 rød
  label: label.slice(0, 80),
  custom_id,
});
const actionRows = (buttons) =>
  chunk(buttons, 5).map((components) => ({ type: 1, components }));

/* ============================================================
 * Roller
 * ============================================================ */

const memberRoles = (i) => i.member?.roles ?? [];
// Admin = admin-rollen ELLER Discord-tillatelsen «Administrator» (praktisk under oppsett)
const isAdmin = (i) =>
  (BigInt(i.member?.permissions ?? 0) & 0x8n) !== 0n ||
  Boolean(
    process.env.ADMIN_ROLE_ID &&
    memberRoles(i).includes(process.env.ADMIN_ROLE_ID),
  );
const isLeader = (i) =>
  Boolean(
    process.env.LEADER_ROLE_ID &&
    memberRoles(i).includes(process.env.LEADER_ROLE_ID),
  );
const canManage = (i) => isAdmin(i) || isLeader(i);

/* ============================================================
 * Discord REST
 * ============================================================ */

async function discord(path, { method = "GET", body, retry = true } = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 429 && retry) {
    const { retry_after = 1 } = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, Math.min(retry_after, 5) * 1000));
    return discord(path, { method, body, retry: false });
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `Discord ${method} ${path} -> ${res.status}: ${text}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const postToChannel = (channelId, payload) =>
  discord(`/channels/${channelId}/messages`, { method: "POST", body: payload });

async function sendDM(userId, payload) {
  const ch = await discord("/users/@me/channels", {
    method: "POST",
    body: { recipient_id: userId },
  });
  return postToChannel(ch.id, payload);
}

// DM som ikke skal ødelegge noe hvis den feiler (f.eks. stengt DM)
async function tryDM(userId, payload) {
  try {
    await sendDM(userId, { allowed_mentions: { parse: [] }, ...payload });
    return true;
  } catch (err) {
    console.warn("DM feilet for", userId, err.message);
    return false;
  }
}

/* ============================================================
 * DynamoDB-hjelpere
 * ============================================================ */

const taskKey = (id) => ({ PK: `TASK#${id}`, SK: "META" });
const signupKey = (id, uid) => ({ PK: `TASK#${id}`, SK: `SIGNUP#${uid}` });
const completionKey = (id, uid) => ({
  PK: `TASK#${id}`,
  SK: `COMPLETION#${uid}`,
});
const userKey = (uid) => ({ PK: `USER#${uid}`, SK: "PROFILE" });

async function getItem(Key) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key }));
  return Item ?? null;
}
const getTask = (id) => getItem(taskKey(id));
const getSignup = (id, uid) => getItem(signupKey(id, uid));

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(
      new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }),
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getTasks(ids) {
  const unique = [...new Set(ids)];
  const out = [];
  for (const part of chunk(unique, 100)) {
    const r = await db.send(
      new BatchGetCommand({
        RequestItems: { [TABLE]: { Keys: part.map(taskKey) } },
      }),
    );
    out.push(...(r.Responses?.[TABLE] ?? []));
  }
  return out;
}

async function loadSettings() {
  const item = await getItem({ PK: "CONFIG", SK: "SETTINGS" });
  const { PK, SK, updatedAt, ...stored } = item ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Alle påmeldinger for en bruker (via GSI2), nyeste først
function userSignups(userId, statuses) {
  const values = { ":p": `USER#${userId}`, ":s": "SIGNUP#" };
  const placeholders = statuses.map((s, n) => {
    values[`:s${n}`] = s;
    return `:s${n}`;
  });
  return queryAll({
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :p AND begins_with(GSI2SK, :s)",
    FilterExpression: `#st IN (${placeholders.join(", ")})`,
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: values,
    ScanIndexForward: false,
  });
}

async function activeCount(userId) {
  return (await userSignups(userId, ["active"])).length;
}

async function transact(items) {
  try {
    await db.send(new TransactWriteCommand({ TransactItems: items }));
    return { ok: true };
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return { ok: false, reasons: err.CancellationReasons ?? [] };
    }
    throw err;
  }
}
const failedAt = (r, idx) =>
  r.reasons?.[idx]?.Code === "ConditionalCheckFailed";

const signupItem = (taskId, userId, status, ts) => ({
  ...signupKey(taskId, userId),
  entity: "SIGNUP",
  taskId,
  userId,
  status,
  signedUpAt: ts,
  GSI1PK: `SIGNUPSTATUS#${status}`,
  GSI1SK: ts,
  GSI2PK: `USER#${userId}`,
  GSI2SK: `SIGNUP#${ts}`,
});

// Bytter status på en påmelding og holder GSI1 i synk.
// Gir et objekt som kan brukes både i en transaksjon og (via .Update) i UpdateCommand.
function signupUpdate(taskId, userId, from, to, set = {}) {
  const names = { "#st": "status" };
  const values = { ":to": to };
  const sets = ["#st = :to"];
  const removes = [];
  if (INDEXED_STATUSES.has(to)) {
    sets.push("GSI1PK = :g1");
    values[":g1"] = `SIGNUPSTATUS#${to}`;
  } else {
    removes.push("GSI1PK", "GSI1SK");
  }
  Object.entries(set).forEach(([k, v], n) => {
    sets.push(`#k${n} = :v${n}`);
    names[`#k${n}`] = k;
    values[`:v${n}`] = v;
  });
  const fromList = from.map((f, n) => {
    values[`:f${n}`] = f;
    return `:f${n}`;
  });
  return {
    Update: {
      TableName: TABLE,
      Key: signupKey(taskId, userId),
      UpdateExpression:
        `SET ${sets.join(", ")}` +
        (removes.length ? ` REMOVE ${removes.join(", ")}` : ""),
      ConditionExpression: `#st IN (${fromList.join(", ")})`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

const taskSlotUpdate = (taskId, delta) => ({
  Update: {
    TableName: TABLE,
    Key: taskKey(taskId),
    UpdateExpression: "ADD #fs :d",
    ConditionExpression: delta < 0 ? "#fs > :zero" : undefined,
    ExpressionAttributeNames: { "#fs": "filledSlots" },
    ExpressionAttributeValues:
      delta < 0 ? { ":d": delta, ":zero": 0 } : { ":d": delta },
  },
});

// Poeng: atomisk saldo + loggrad. Returnerer to transaksjonselementer.
function pointsOps({
  userId,
  delta,
  basePoints = delta,
  multiplier = 1,
  reason,
  givenBy,
  taskId,
}) {
  const ts = now();
  const update = {
    Update: {
      TableName: TABLE,
      Key: userKey(userId),
      UpdateExpression:
        "SET createdAt = if_not_exists(createdAt, :ts) ADD #pts :d, totalEarned :d",
      ExpressionAttributeNames: { "#pts": "points" },
      ExpressionAttributeValues: { ":ts": ts, ":d": delta },
    },
  };
  if (delta < 0) {
    update.Update.ConditionExpression = "#pts >= :min";
    update.Update.ExpressionAttributeValues[":min"] = -delta;
  }
  const log = {
    Put: {
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: `LOG#${ts}#${randomUUID()}`,
        entity: "LOG",
        delta,
        basePoints,
        multiplier,
        reason,
        givenBy,
        taskId,
        createdAt: ts,
      },
    },
  };
  return [update, log];
}

/* ============================================================
 * Visning: oppgaveliste og «mine oppgaver»
 * ============================================================ */

const MY_STATUS_TEXT = {
  active: "✅ Du er påmeldt",
  waitlist: "🕒 Du står på venteliste",
  submitted: "📤 Venter på godkjenning",
  done: "🏅 Fullført av deg",
};

function taskLine(t, myStatus) {
  const free = Math.max(0, t.slots - t.filledSlots);
  const spots =
    free > 0
      ? `${free} av ${t.slots} ledig${free === 1 ? "" : "e"}`
      : "full (venteliste)";
  const parts = [
    `**${t.title}**`,
    SIZES[t.size] ?? t.size,
    `${t.points} poeng`,
    spots,
  ];
  if (t.deadline) parts.push(`frist ${fmtDate(t.deadline)}`);
  let line = parts.join(" · ");
  if (t.description) line += `\n> ${t.description.slice(0, 80)}`;
  if (myStatus && MY_STATUS_TEXT[myStatus])
    line += `\n${MY_STATUS_TEXT[myStatus]}`;
  return line;
}

async function renderTaskList(userId, notice = "") {
  const r = await db.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :p",
      ExpressionAttributeValues: { ":p": "TASKSTATUS#open" },
      Limit: MAX_LIST + 1,
    }),
  );
  const all = r.Items ?? [];
  const tasks = all.slice(0, MAX_LIST);
  const more = all.length > MAX_LIST;

  if (!tasks.length) {
    return {
      content: notice,
      embeds: [
        {
          title: "Ledige oppgaver",
          description:
            "Ingen ledige oppgaver akkurat nå 🎉 Sjekk igjen litt senere!",
          color: 0x5865f2,
        },
      ],
      components: [],
    };
  }

  const mine = new Map(
    (
      await userSignups(userId, ["active", "waitlist", "submitted", "done"])
    ).map((s) => [s.taskId, s.status]),
  );

  const buttons = tasks
    .filter((t) => !mine.has(t.id))
    .map((t) =>
      t.filledSlots < t.slots
        ? button(1, `🙋 Meld meg på: ${t.title}`, `signup:${t.id}`)
        : button(2, `🕒 Venteliste: ${t.title}`, `signup:${t.id}`),
    );

  let description = tasks.map((t) => taskLine(t, mine.get(t.id))).join("\n\n");
  if (more)
    description += "\n\n…og flere. De dukker opp når noen blir ferdige.";

  return {
    content: notice,
    embeds: [
      {
        title: "Ledige oppgaver",
        description: description.slice(0, 4000),
        color: 0x5865f2,
        footer: {
          text: "Rekker du ikke en oppgave? Det er helt greit å slippe den.",
        },
      },
    ],
    components: actionRows(buttons),
  };
}

async function renderMine(userId, notice = "") {
  const [signups, settings] = await Promise.all([
    userSignups(userId, ["active", "waitlist", "submitted"]),
    loadSettings(),
  ]);
  const tasks = await getTasks(signups.map((s) => s.taskId));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const shown = signups.filter((s) => byId.has(s.taskId)).slice(0, MAX_LIST);

  if (!shown.length) {
    return {
      content: notice,
      embeds: [
        {
          title: "Mine oppgaver",
          description:
            "Du har ingen aktive oppgaver. Se hva som er ledig med `/oppgaver` 🙂",
          color: 0x57f287,
        },
      ],
      components: [],
    };
  }

  const lines = shown.map((s) => {
    const t = byId.get(s.taskId);
    const when = t.deadline ? ` · frist ${fmtDate(t.deadline)}` : "";
    return `**${t.title}** · ${t.points} poeng${when}\n${MY_STATUS_TEXT[s.status]}`;
  });

  const buttons = shown
    .filter((s) => s.status !== "submitted")
    .map((s) => {
      const t = byId.get(s.taskId);
      return button(
        2,
        s.status === "waitlist"
          ? `Forlat ventelisten: ${t.title}`
          : `Slipp: ${t.title}`,
        `drop:${t.id}`,
      );
    });

  const activeN = shown.filter((s) => s.status === "active").length;
  const limit =
    settings.maxActiveTasks > 0
      ? `${activeN}/${settings.maxActiveTasks}`
      : `${activeN}`;

  return {
    content: notice,
    embeds: [
      {
        title: "Mine oppgaver",
        description: lines.join("\n\n").slice(0, 4000),
        color: 0x57f287,
        footer: { text: `Aktive oppgaver: ${limit}. Ferdig? Bruk /ferdig.` },
      },
    ],
    components: actionRows(buttons),
  };
}

/* ============================================================
 * Påmelding, venteliste og slipp
 * ============================================================ */

async function signUp(taskId, userId) {
  const task = await getTask(taskId);
  if (!task || task.status !== "open")
    return "Den oppgaven finnes ikke lenger eller er ikke åpen.";

  const existing = await getSignup(taskId, userId);
  if (existing && !["dropped", "cancelled"].includes(existing.status)) {
    if (existing.status === "waitlist")
      return "Du står allerede på ventelisten for den.";
    if (existing.status === "done")
      return "Du har allerede fullført den oppgaven 🏅";
    return "Du er allerede påmeldt den oppgaven 🙂";
  }

  const ts = now();
  const putCondition = {
    ConditionExpression: "attribute_not_exists(PK) OR #st IN (:d, :c)",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: { ":d": "dropped", ":c": "cancelled" },
  };

  if (task.filledSlots < task.slots) {
    const settings = await loadSettings();
    if (settings.maxActiveTasks > 0) {
      const n = await activeCount(userId);
      if (n >= settings.maxActiveTasks) {
        return `Du har allerede ${n} aktive oppgaver (maks ${settings.maxActiveTasks}). Ferdigmeld eller slipp en først, så er det plass til en ny 🙂`;
      }
    }

    const r = await transact([
      {
        Update: {
          TableName: TABLE,
          Key: taskKey(taskId),
          UpdateExpression: "ADD #fs :one",
          ConditionExpression: "#st = :open AND #fs < #sl",
          ExpressionAttributeNames: {
            "#fs": "filledSlots",
            "#sl": "slots",
            "#st": "status",
          },
          ExpressionAttributeValues: { ":one": 1, ":open": "open" },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: signupItem(taskId, userId, "active", ts),
          ...putCondition,
        },
      },
    ]);
    if (r.ok) {
      const dl = task.deadline ? ` Fristen er ${fmtDate(task.deadline)}.` : "";
      return `🙌 Du er påmeldt **${task.title}**!${dl} Når du er ferdig, bruker du \`/ferdig\`.`;
    }
    if (failedAt(r, 1)) return "Du er allerede påmeldt den oppgaven 🙂";
    // Ellers ble den full mens vi holdt på → gå videre til venteliste
  }

  try {
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: signupItem(taskId, userId, "waitlist", ts),
        ...putCondition,
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return "Du er allerede påmeldt den oppgaven 🙂";
    throw err;
  }
  return `🕒 **${task.title}** er full, så du står nå på venteliste. Du får en DM hvis det blir plass!`;
}

// Finn eldste på venteliste som har plass til flere aktive oppgaver
async function nextWaitlisted(taskId, settings) {
  const waiting = await queryAll({
    KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
    FilterExpression: "#st = :w",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: {
      ":p": `TASK#${taskId}`,
      ":s": "SIGNUP#",
      ":w": "waitlist",
    },
  });
  waiting.sort((a, b) => a.signedUpAt.localeCompare(b.signedUpAt));
  for (const w of waiting) {
    if (
      settings.maxActiveTasks > 0 &&
      (await activeCount(w.userId)) >= settings.maxActiveTasks
    )
      continue;
    return w;
  }
  return null;
}

async function dropSignup(taskId, userId, { via } = {}) {
  const signup = await getSignup(taskId, userId);
  if (!signup || !["active", "waitlist"].includes(signup.status))
    return { ok: false, notice: "Du er ikke påmeldt den oppgaven (lenger)." };

  const task = await getTask(taskId);
  const title = task?.title ?? "oppgaven";
  const ts = now();
  const extra = {
    droppedAt: ts,
    ...(via === "checkin" ? { checkinAnswer: "dropped" } : {}),
  };

  if (signup.status === "waitlist") {
    const r = await transact([
      signupUpdate(taskId, userId, ["waitlist"], "dropped", extra),
    ]);
    return r.ok
      ? {
          ok: true,
          title,
          notice: `👋 Du er tatt av ventelisten for **${title}**.`,
        }
      : { ok: false, notice: "Du er ikke på ventelisten (lenger)." };
  }

  const settings = await loadSettings();
  let promoted = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cand = attempt < 2 ? await nextWaitlisted(taskId, settings) : null;
    const items = [signupUpdate(taskId, userId, ["active"], "dropped", extra)];
    if (cand) {
      // Plassen går direkte videre til neste på ventelisten (filledSlots uendret)
      items.push(
        signupUpdate(taskId, cand.userId, ["waitlist"], "active", {
          signedUpAt: ts,
          GSI1SK: ts,
          GSI2SK: `SIGNUP#${ts}`,
        }),
      );
    } else {
      items.push(taskSlotUpdate(taskId, -1));
    }
    const r = await transact(items);
    if (r.ok) {
      promoted = cand;
      break;
    }
    if (failedAt(r, 0))
      return { ok: false, notice: "Du er ikke påmeldt den oppgaven (lenger)." };
    // ellers endret ventelisten seg underveis → prøv igjen
    if (attempt === 2)
      return {
        ok: false,
        notice: "Noe skjedde samtidig. Prøv igjen om litt 🙂",
      };
  }

  if (promoted) {
    await tryDM(promoted.userId, {
      content: `🎉 Det ble ledig plass! Du har fått plassen på **${title}**. Bruk \`/mine-oppgaver\` for å se den, og \`/ferdig\` når du er ferdig.`,
    });
  }
  return {
    ok: true,
    title,
    notice: `👋 Du slapp **${title}**. Takk for at du ga beskjed!`,
  };
}

/* ============================================================
 * Ferdigmelding og godkjenning
 * ============================================================ */

async function cmdFerdig(i, opts, userId) {
  const taskId = opts.oppgave;
  const signup = taskId ? await getSignup(taskId, userId) : null;
  if (!signup)
    return ephemeral(
      "Velg en av oppgavene dine fra listen som dukker opp når du skriver `/ferdig` 🙂",
    );
  if (signup.status === "waitlist")
    return ephemeral(
      "Du står på venteliste for den, så den kan ikke ferdigmeldes ennå.",
    );
  if (signup.status === "submitted")
    return ephemeral("Den er allerede ferdigmeldt og venter på godkjenning 👍");
  if (signup.status === "done") return ephemeral("Den er allerede godkjent 🏅");
  if (signup.status !== "active")
    return ephemeral("Du er ikke påmeldt den oppgaven.");

  const [task, settings] = await Promise.all([getTask(taskId), loadSettings()]);
  if (!task) return ephemeral("Fant ikke oppgaven.");
  if (!settings.adminChannelId)
    return ephemeral(
      "Admin-kanalen er ikke satt opp ennå. Be en admin bruke `/innstillinger`.",
    );

  const attachment = opts.bilde
    ? i.data.resolved?.attachments?.[opts.bilde]
    : null;
  if (attachment?.content_type && !attachment.content_type.startsWith("image/"))
    return ephemeral("Vedlegget må være et bilde.");
  const photoUrl = attachment?.url;

  const ts = now();
  const r = await transact([
    signupUpdate(taskId, userId, ["active"], "submitted", { submittedAt: ts }),
    {
      Put: {
        TableName: TABLE,
        Item: {
          ...completionKey(taskId, userId),
          entity: "COMPLETION",
          taskId,
          userId,
          photoUrl,
          status: "pending",
          submittedAt: ts,
        },
      },
    },
  ]);
  if (!r.ok) return ephemeral("Noe skjedde samtidig. Prøv igjen om litt 🙂");

  try {
    const msg = await postToChannel(settings.adminChannelId, {
      content: `📥 Ny ferdigmelding fra <@${userId}>`,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: task.title,
          description: task.description?.slice(0, 300),
          color: 0xfee75c,
          fields: [
            { name: "Poeng", value: String(task.points), inline: true },
            {
              name: "Størrelse",
              value: SIZES[task.size] ?? task.size,
              inline: true,
            },
          ],
          image: photoUrl ? { url: photoUrl } : undefined,
        },
      ],
      components: [
        {
          type: 1,
          components: [
            button(3, "✅ Godkjenn", `approve:${taskId}:${userId}`),
            button(4, "❌ Avslå", `reject:${taskId}:${userId}`),
          ],
        },
      ],
    });
    await db
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: completionKey(taskId, userId),
          UpdateExpression: "SET adminChannelId = :c, adminMessageId = :m",
          ExpressionAttributeValues: { ":c": msg.channel_id, ":m": msg.id },
        }),
      )
      .catch((e) =>
        console.warn("Kunne ikke lagre admin-melding-ID", e.message),
      );
  } catch (err) {
    console.error("Kunne ikke poste til admin-kanalen", err);
    // Rull tilbake slik at den frivillige kan prøve igjen
    await transact([
      signupUpdate(taskId, userId, ["submitted"], "active"),
    ]).catch(() => {});
    await db
      .send(
        new DeleteCommand({
          TableName: TABLE,
          Key: completionKey(taskId, userId),
        }),
      )
      .catch(() => {});
    return ephemeral(
      "Jeg klarte ikke å varsle admin akkurat nå. Prøv igjen om litt 🙏",
    );
  }

  const photoNote = photoUrl
    ? "\n_Husk: bilder skal vise oppgaven, ikke personer._"
    : "";
  return ephemeral(
    `📤 Takk! **${task.title}** er ferdigmeldt. En admin eller leder ser på den snart.${photoNote}`,
  );
}

async function approveCompletion(taskId, userId, reviewerId) {
  const [task, completion] = await Promise.all([
    getTask(taskId),
    getItem(completionKey(taskId, userId)),
  ]);
  if (!task || !completion)
    return { ok: false, text: "Fant ikke ferdigmeldingen." };

  const ts = now();
  const items = [
    {
      Update: {
        TableName: TABLE,
        Key: completionKey(taskId, userId),
        UpdateExpression:
          "SET #st = :a, reviewedBy = :r, reviewedAt = :ts, GSI1PK = :wk, GSI1SK = :ts, pointsAwarded = :pts",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":a": "approved",
          ":wk": `APPROVED#${isoWeekKey(todayOslo())}`,
          ":pts": task.points ?? 0,
          ":p": "pending",
          ":r": reviewerId,
          ":ts": ts,
        },
      },
    },
    signupUpdate(taskId, userId, ["submitted"], "done", { doneAt: ts }),
    {
      Update: {
        TableName: TABLE,
        Key: taskKey(taskId),
        UpdateExpression: "ADD doneCount :one",
        ExpressionAttributeValues: { ":one": 1 },
      },
    },
  ];
  if (task.points > 0) {
    items.push(
      ...pointsOps({
        userId,
        delta: task.points,
        reason: `Fullført oppgave: ${task.title}`,
        givenBy: reviewerId,
        taskId,
      }),
    );
  }

  const r = await transact(items);
  if (!r.ok) return { ok: false, text: "Denne er allerede behandlet." };

  // Lukk oppgaven når alle plasser er fullført
  await db
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: taskKey(taskId),
        UpdateExpression: "SET #st = :done REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "#st = :open AND doneCount >= #sl",
        ExpressionAttributeNames: { "#st": "status", "#sl": "slots" },
        ExpressionAttributeValues: { ":done": "done", ":open": "open" },
      }),
    )
    .catch((e) => {
      if (e.name !== "ConditionalCheckFailedException") throw e;
    });

  return { ok: true, task };
}

async function rejectCompletion(taskId, userId, reviewerId, comment) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, text: "Fant ikke oppgaven." };
  const ts = now();
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: completionKey(taskId, userId),
        UpdateExpression:
          "SET #st = :r, reviewedBy = :by, reviewedAt = :ts, #cm = :cm",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status", "#cm": "comment" },
        ExpressionAttributeValues: {
          ":r": "rejected",
          ":p": "pending",
          ":by": reviewerId,
          ":ts": ts,
          ":cm": comment || "",
        },
      },
    },
    signupUpdate(taskId, userId, ["submitted"], "active", { rejectedAt: ts }),
  ]);
  if (!r.ok) return { ok: false, text: "Denne er allerede behandlet." };
  return { ok: true, task };
}

/* ============================================================
 * Innsjekk (EventBridge, hver time)
 * ============================================================ */

function checkinPayload(task, userId, days) {
  return {
    content:
      `Hei! 👋 Du meldte deg på **${task.title}** for ${days} dager siden. Hvordan går det?\n` +
      `Ingen stress. Du kan beholde oppgaven eller slippe den uten at det får noen konsekvenser.`,
    components: [
      {
        type: 1,
        components: [
          button(3, "Jeg beholder den", `checkin_keep:${task.id}:${userId}`),
          button(2, "Slipp oppgaven", `checkin_drop:${task.id}:${userId}`),
        ],
      },
    ],
  };
}

async function runCheckins() {
  const settings = await loadSettings();
  const cutoff = new Date(
    Date.now() - settings.checkinDays * 24 * 3600 * 1000,
  ).toISOString();

  const due = await queryAll({
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p AND GSI1SK < :c",
    FilterExpression: "attribute_not_exists(checkinSentAt)",
    ExpressionAttributeValues: { ":p": "SIGNUPSTATUS#active", ":c": cutoff },
  });

  let sent = 0;
  for (const s of due) {
    // «Claim» først, så ingen får to innsjekker selv om jobben kjører parallelt
    try {
      await db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: signupKey(s.taskId, s.userId),
          UpdateExpression: "SET checkinSentAt = :ts",
          ConditionExpression:
            "#st = :a AND attribute_not_exists(checkinSentAt)",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: { ":ts": now(), ":a": "active" },
        }),
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") continue;
      throw err;
    }

    const task = await getTask(s.taskId);
    if (!task) continue;
    const payload = checkinPayload(task, s.userId, settings.checkinDays);

    if (await tryDM(s.userId, payload)) {
      sent++;
      continue;
    }
    // DM stengt → reservekanal (eller admin-kanalen)
    const channel = settings.fallbackChannelId || settings.adminChannelId;
    if (!channel) {
      console.warn("Ingen reservekanal satt; innsjekk uteble for", s.userId);
      continue;
    }
    try {
      await postToChannel(channel, {
        ...payload,
        content: `<@${s.userId}> (DM er stengt, så jeg spør her)\n${payload.content}`,
        allowed_mentions: { users: [s.userId] },
      });
      sent++;
    } catch (err) {
      console.error("Reservekanal feilet", err.message);
    }
  }
  return { due: due.length, sent };
}

async function runJob(job) {
  switch (job) {
    case "checkin":
      return runCheckins();
    case "nightly":
      return runNightly();
    case "weekly":
      return runWeekly();
    default:
      console.log("Ukjent eller ikke-implementert jobb:", job);
      return { skipped: job };
  }
}

/* ============================================================
 * Slash-kommandoer
 * ============================================================ */

async function cmdOppgaver(i, opts, userId) {
  return message({ ...(await renderTaskList(userId)), flags: 64 });
}

async function cmdMine(i, opts, userId) {
  return message({ ...(await renderMine(userId)), flags: 64 });
}

async function cmdPoeng(i, opts, userId) {
  const profile = await getItem(userKey(userId));
  if (!profile)
    return ephemeral(
      "Du har ikke fått poeng ennå. Ta en oppgave med `/oppgaver` 💪",
    );
  const { Items: logs = [] } = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :p AND begins_with(SK, :l)",
      ExpressionAttributeValues: { ":p": `USER#${userId}`, ":l": "LOG#" },
      ScanIndexForward: false,
      Limit: 5,
    }),
  );
  const recent = logs
    .map(
      (l) =>
        `${l.delta > 0 ? "+" : ""}${l.delta} · ${l.reason} · ${discordTime(l.createdAt)}`,
    )
    .join("\n");
  return ephemeral(
    `⭐ Du har **${profile.points ?? 0} poeng**.` +
      (recent ? `\n\n**Siste endringer**\n${recent}` : ""),
  );
}

async function cmdOppgaveNy(i, opts, userId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const size = opts["størrelse"];
  if (opts.frist) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(opts.frist) ||
      Number.isNaN(Date.parse(opts.frist))
    )
      return ephemeral("Bruk datoformatet ÅÅÅÅ-MM-DD, f.eks. 2026-11-20.");
    if (opts.frist < todayOslo())
      return ephemeral("Fristen kan ikke være i fortiden.");
  }
  const settings = await loadSettings();
  const points = opts.poeng ?? settings[SIZE_SETTING[size]];
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: buildTaskItem({
        title: opts.tittel,
        description: opts.beskrivelse,
        size,
        points,
        slots: opts.plasser ?? 1,
        deadline: opts.frist,
        createdBy: userId,
      }),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );

  return message({
    content:
      `📋 **Ny oppgave:** ${opts.tittel}\n` +
      `${SIZES[size]} · ${points} poeng · ${opts.plasser ?? 1} plass${(opts.plasser ?? 1) === 1 ? "" : "er"}` +
      (opts.frist ? ` · frist ${fmtDate(opts.frist)}` : "") +
      `\nMeld deg på med \`/oppgaver\`!`,
  });
}

async function cmdOppgaveSlett(i, opts, userId) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const taskId = opts.oppgave;
  const task = taskId ? await getTask(taskId) : null;
  if (!task || task.status !== "open")
    return ephemeral("Velg en åpen oppgave fra listen som dukker opp.");

  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: taskKey(taskId),
        UpdateExpression:
          "SET #st = :del, deletedBy = :by, deletedAt = :ts REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "#st = :open",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":del": "deleted",
          ":open": "open",
          ":by": userId,
          ":ts": now(),
        },
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return ephemeral("Oppgaven er allerede fjernet eller lukket.");
    throw err;
  }

  // Avslutt påmeldinger og gi beskjed (best effort)
  const signups = await queryAll({
    KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
    ExpressionAttributeValues: { ":p": `TASK#${taskId}`, ":s": "SIGNUP#" },
  });
  let notified = 0;
  for (const s of signups.filter((x) => INDEXED_STATUSES.has(x.status))) {
    await db
      .send(
        new UpdateCommand(
          signupUpdate(taskId, s.userId, [s.status], "cancelled").Update,
        ),
      )
      .catch(() => {});
    if (
      await tryDM(s.userId, {
        content: `Oppgaven **${task.title}** er fjernet av en admin, så påmeldingen din er avsluttet. Takk likevel! 💙`,
      })
    )
      notified++;
  }
  return ephemeral(
    `🗑️ Fjernet **${task.title}**. ${signups.length ? `${notified} påmeldte fikk beskjed på DM.` : ""}`,
  );
}

async function cmdPoengJuster(i, opts, userId) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const delta = opts.antall;
  if (!delta) return ephemeral("Antall kan ikke være 0.");
  const r = await transact(
    pointsOps({
      userId: opts.bruker,
      delta,
      reason: `Justering: ${opts.begrunnelse}`,
      givenBy: userId,
    }),
  );
  if (!r.ok)
    return ephemeral("Brukeren har ikke nok poeng til å trekke så mange.");
  const profile = await getItem(userKey(opts.bruker));
  return ephemeral(
    `✅ Justerte <@${opts.bruker}> med ${delta > 0 ? "+" : ""}${delta} poeng. Ny saldo: **${profile?.points ?? 0}**.`,
  );
}

async function cmdLogg(i, opts) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const { Items: logs = [] } = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :p AND begins_with(SK, :l)",
      ExpressionAttributeValues: { ":p": `USER#${opts.bruker}`, ":l": "LOG#" },
      ScanIndexForward: false,
      Limit: 15,
    }),
  );
  if (!logs.length) return ephemeral(`Ingen poenglogg for <@${opts.bruker}>.`);
  const lines = logs.map(
    (l) =>
      `${l.delta > 0 ? "+" : ""}${l.delta} (grunnlag ${l.basePoints}, ×${l.multiplier}) · ${l.reason} · av <@${l.givenBy}> · ${discordTime(l.createdAt)}`,
  );
  return ephemeral(
    `**Siste 15 poengendringer for <@${opts.bruker}>**\n${lines.join("\n")}`.slice(
      0,
      1990,
    ),
  );
}

async function cmdInnstillinger(i, opts) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const settings = await loadSettings();
  const show = (key, v) =>
    SETTING_DEFS[key].type === "id" && v ? `<#${v}>` : (v ?? "_ikke satt_");

  if (!opts.innstilling) {
    const lines = Object.entries(SETTING_DEFS).map(
      ([key, def]) => `• ${def.label}: **${show(key, settings[key])}**`,
    );
    return ephemeral(
      `**Innstillinger**\n${lines.join("\n")}\n\nEndre med \`/innstillinger innstilling:… verdi:…\``,
    );
  }

  const def = SETTING_DEFS[opts.innstilling];
  if (!def) return ephemeral("Ukjent innstilling.");
  if (opts.verdi == null || opts.verdi === "")
    return ephemeral("Oppgi også en verdi.");

  let value;
  if (def.type === "int") {
    if (!/^\d+$/.test(opts.verdi))
      return ephemeral("Verdien må være et heltall.");
    value = Number(opts.verdi);
    if (value < def.min || value > def.max)
      return ephemeral(`Verdien må være mellom ${def.min} og ${def.max}.`);
  } else {
    const m = opts.verdi.match(/^(?:<#)?(\d{5,25})>?$/); // lim inn ID eller #kanal
    if (!m) return ephemeral("Oppgi en kanal-ID (eller lim inn #kanal).");
    value = m[1];
  }

  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "CONFIG", SK: "SETTINGS" },
      UpdateExpression: "SET #k = :v, updatedAt = :ts",
      ExpressionAttributeNames: { "#k": opts.innstilling },
      ExpressionAttributeValues: { ":v": value, ":ts": now() },
    }),
  );
  return ephemeral(`✅ ${def.label}: **${show(opts.innstilling, value)}**`);
}

const COMMANDS = {
  oppgaver: cmdOppgaver,
  "mine-oppgaver": cmdMine,
  ferdig: cmdFerdig,
  poeng: cmdPoeng,
  "oppgave-ny": cmdOppgaveNy,
  "oppgave-slett": cmdOppgaveSlett,
  "poeng-juster": cmdPoengJuster,
  logg: cmdLogg,
  innstillinger: cmdInnstillinger,
  "mal-ny": cmdMalNy,
  "mal-liste": cmdMalListe,
  "mal-slett": cmdMalSlett,
  møte: cmdMote,
  foreslå: cmdForesla,
};

async function handleCommand(i) {
  const fn = COMMANDS[i.data.name];
  if (!fn) return ephemeral("Den kommandoen kjenner jeg ikke ennå 🤔");
  const opts = Object.fromEntries(
    (i.data.options ?? []).map((o) => [o.name, o.value]),
  );
  return fn(i, opts, userOf(i).id);
}

/* ============================================================
 * Autocomplete
 * ============================================================ */

async function handleAutocomplete(i) {
  const focused = i.data.options?.find((o) => o.focused);
  const typed = String(focused?.value ?? "").toLowerCase();
  let tasks = [];

  if (i.data.name === "ferdig") {
    const signups = await userSignups(userOf(i).id, ["active"]);
    tasks = await getTasks(signups.map((s) => s.taskId));
  } else if (i.data.name === "oppgave-slett" && isAdmin(i)) {
    const r = await db.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :p",
        ExpressionAttributeValues: { ":p": "TASKSTATUS#open" },
        Limit: 100,
      }),
    );
    tasks = r.Items ?? [];
  }

  if (i.data.name === "mal-slett" && isAdmin(i)) {
    tasks = await listTemplates();
  }

  const choices = tasks
    .filter((t) => t.title.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((t) => ({ name: t.title.slice(0, 100), value: t.id }));
  return json({ type: 8, data: { choices } });
}

/* ============================================================
 * Knapper og modaler (all info ligger i custom_id)
 * ============================================================ */

async function handleComponent(i) {
  const [action, taskId, targetId] = i.data.custom_id.split(":");
  const user = userOf(i);

  switch (action) {
    case "signup": {
      const notice = await signUp(taskId, user.id);
      return updateMessage(await renderTaskList(user.id, notice));
    }

    case "drop": {
      const r = await dropSignup(taskId, user.id);
      return updateMessage(await renderMine(user.id, r.notice));
    }

    case "checkin_keep":
    case "checkin_drop": {
      if (targetId !== user.id)
        return ephemeral("Denne knappen er ikke til deg 🙂");
      const task = await getTask(taskId);
      const title = task?.title ?? "oppgaven";

      if (action === "checkin_keep") {
        try {
          await db.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: signupKey(taskId, user.id),
              UpdateExpression: "SET checkinAnswer = :k",
              ConditionExpression: "#st = :a",
              ExpressionAttributeNames: { "#st": "status" },
              ExpressionAttributeValues: { ":k": "kept", ":a": "active" },
            }),
          );
        } catch (err) {
          if (err.name !== "ConditionalCheckFailedException") throw err;
          return updateMessage({
            content: `Den oppgaven er ikke aktiv lenger, så du trenger ikke gjøre noe 🙂`,
            components: [],
          });
        }
        return updateMessage({
          content: `👍 Supert, du beholder **${title}**. Si fra med \`/ferdig\` når den er gjort.`,
          components: [],
        });
      }

      const r = await dropSignup(taskId, user.id, { via: "checkin" });
      return updateMessage({
        content: r.ok
          ? `Du har sluppet **${title}**. Takk for at du ga beskjed! 💙`
          : r.notice,
        components: [],
      });
    }

    case "approve": {
      if (!canManage(i)) return ephemeral(NO_ACCESS);
      if (targetId === user.id && !isAdmin(i))
        return ephemeral("Du kan ikke godkjenne din egen ferdigmelding 🙂");
      const r = await approveCompletion(taskId, targetId, user.id);
      if (!r.ok) return ephemeral(r.text);
      await tryDM(targetId, {
        content: `🎉 **${r.task.title}** er godkjent! Du fikk ${r.task.points} poeng. Takk for innsatsen!`,
      });
      return updateMessage({
        content: `✅ Godkjent av <@${user.id}> · <@${targetId}> fikk ${r.task.points} poeng for **${r.task.title}**`,
        embeds: i.message?.embeds ?? [],
        components: [],
      });
    }

    case "reject": {
      if (!canManage(i)) return ephemeral(NO_ACCESS);
      if (targetId === user.id && !isAdmin(i))
        return ephemeral("Du kan ikke avslå din egen ferdigmelding 🙂");
      return json({
        type: 9,
        data: {
          custom_id: `reject_modal:${taskId}:${targetId}`,
          title: "Avslå ferdigmelding",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "comment",
                  label: "Kommentar til den frivillige (valgfri)",
                  style: 2,
                  required: false,
                  max_length: 500,
                },
              ],
            },
          ],
        },
      });
    }

    case "mt_join":
    case "mt_leave":
    case "mt_here": {
      const fn = {
        mt_join: meetingJoin,
        mt_leave: meetingLeave,
        mt_here: meetingHere,
      }[action];
      const notice = await fn(taskId, user.id); // taskId = møte-ID her
      const m = await getItem(meetingKey(taskId));
      if (m && i.message) {
        await discord(
          `/channels/${i.message.channel_id ?? i.channel_id}/messages/${i.message.id}`,
          {
            method: "PATCH",
            body: renderMeeting(m),
          },
        ).catch((e) =>
          console.warn("Kunne ikke oppdatere møtemelding", e.message),
        );
      }
      return ephemeral(notice);
    }

    case "sg_ok":
    case "sg_no":
      if (!canManage(i)) return ephemeral(NO_ACCESS);
      return suggestionOpenModal(action, taskId); // taskId = forslags-ID her

    default:
      return ephemeral("Jeg skjønte ikke den knappen 🤔");
  }
}

async function handleModal(i) {
  const [action, taskId, targetId] = i.data.custom_id.split(":");
  if (action === "sg_ok_modal") return suggestionApprove(i, taskId);
  if (action === "sg_no_modal") return suggestionReject(i, taskId);
  if (action !== "reject_modal") return ephemeral("Ukjent skjema.");
  const user = userOf(i);
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  if (targetId === user.id && !isAdmin(i))
    return ephemeral("Du kan ikke avslå din egen ferdigmelding 🙂");

  const comment = i.data.components?.[0]?.components?.[0]?.value?.trim() ?? "";
  const r = await rejectCompletion(taskId, targetId, user.id, comment);
  if (!r.ok) return ephemeral(r.text);

  await tryDM(targetId, {
    content:
      `Hei! Ferdigmeldingen din for **${r.task.title}** ble ikke godkjent denne gangen.` +
      (comment ? `\n> ${comment}` : "") +
      `\nOppgaven er fortsatt din, så du kan fikse det og bruke \`/ferdig\` igjen 💙`,
  });
  return updateMessage({
    content: `❌ Avslått av <@${user.id}>${comment ? `: ${comment}` : ""}`,
    embeds: i.message?.embeds ?? [],
    components: [],
  });
}

/* ============================================================
 * Fase 2: datoer (Europe/Oslo)
 * ============================================================ */

const pad = (n) => String(n).padStart(2, "0");
const INTERVALS = {
  weekly: "ukentlig",
  monthly: "månedlig",
  quarterly: "kvartalsvis",
};
const WEEKDAYS = [
  "mandag",
  "tirsdag",
  "onsdag",
  "torsdag",
  "fredag",
  "lørdag",
  "søndag",
];

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1 = mandag … 7 = søndag
}

function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${pad(week)}`;
}

function osloOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(
    g("year"),
    g("month") - 1,
    g("day"),
    g("hour"),
    g("minute"),
    g("second"),
  );
  return Math.round((asUtc - utcMs) / 60000);
}

// «2026-11-20» + «18:30» (norsk tid) → ISO-streng i UTC
function osloLocalToIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ms = guess - osloOffsetMinutes(guess) * 60000;
  ms = guess - osloOffsetMinutes(ms) * 60000;
  return new Date(ms).toISOString();
}

// Hvilken periode vi er i, og når oppgaven fra malen «åpner» i den perioden
function periodFor(interval, anchorDay, today) {
  const [y, m] = today.split("-").map(Number);
  if (interval === "weekly") {
    const monday = addDays(today, -(isoWeekday(today) - 1));
    return {
      key: isoWeekKey(today),
      anchorDate: addDays(monday, anchorDay - 1),
    };
  }
  if (interval === "monthly") {
    return {
      key: `${y}-${pad(m)}`,
      anchorDate: `${y}-${pad(m)}-${pad(anchorDay)}`,
    };
  }
  const q = Math.floor((m - 1) / 3);
  return {
    key: `${y}-Q${q + 1}`,
    anchorDate: `${y}-${pad(q * 3 + 1)}-${pad(anchorDay)}`,
  };
}

function describeSchedule(tpl) {
  if (tpl.interval === "weekly") return `hver ${WEEKDAYS[tpl.anchorDay - 1]}`;
  if (tpl.interval === "monthly") return `den ${tpl.anchorDay}. hver måned`;
  return `den ${tpl.anchorDay}. første måned i hvert kvartal`;
}

/* ============================================================
 * Fase 2: felles oppgavebygger, maler og automatikk
 * ============================================================ */

function buildTaskItem({
  title,
  description,
  size,
  points,
  slots = 1,
  deadline,
  createdBy,
  templateId,
}) {
  const id = randomBytes(4).toString("hex");
  const createdAt = now();
  return {
    ...taskKey(id),
    entity: "TASK",
    id,
    title,
    description,
    size,
    points,
    slots,
    filledSlots: 0,
    doneCount: 0,
    deadline,
    templateId,
    status: "open",
    createdBy,
    createdAt,
    GSI1PK: "TASKSTATUS#open",
    GSI1SK: deadline ? `${deadline}T23:59:59` : createdAt,
  };
}

const templateKey = (id) => ({ PK: `TEMPLATE#${id}`, SK: "META" });
const listTemplates = () =>
  queryAll({
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "TEMPLATES" },
  });

// Gamle, urørte oppgaver fra forrige periode fjernes når en ny åpnes
async function expireIfUntouched(taskId) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: taskKey(taskId),
        UpdateExpression: "SET #st = :ex REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "#st = :open AND #fs = :zero",
        ExpressionAttributeNames: { "#st": "status", "#fs": "filledSlots" },
        ExpressionAttributeValues: {
          ":ex": "expired",
          ":open": "open",
          ":zero": 0,
        },
      }),
    );
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }
}

// Oppretter oppgave fra mal hvis perioden har startet og den ikke allerede er laget (idempotent)
async function spawnFromTemplate(tpl, today) {
  const { key, anchorDate } = periodFor(tpl.interval, tpl.anchorDay, today);
  if (today < anchorDate || tpl.lastPeriod === key) return null;

  const task = buildTaskItem({
    title: tpl.title,
    description: tpl.description,
    size: tpl.size,
    points: tpl.points,
    slots: tpl.slots,
    deadline: tpl.dueDays ? addDays(anchorDate, tpl.dueDays) : undefined,
    createdBy: "system",
    templateId: tpl.id,
  });
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: templateKey(tpl.id),
        UpdateExpression: "SET lastPeriod = :k, lastTaskId = :t",
        ConditionExpression:
          "attribute_not_exists(lastPeriod) OR lastPeriod <> :k",
        ExpressionAttributeValues: { ":k": key, ":t": task.id },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: task,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ]);
  if (!r.ok) return null;
  if (tpl.lastTaskId) await expireIfUntouched(tpl.lastTaskId);
  return task;
}

async function claimJob(name, key) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `JOB#${name}`, SK: "STATE" },
        UpdateExpression: "SET lastKey = :k, ranAt = :ts",
        ConditionExpression: "attribute_not_exists(lastKey) OR lastKey <> :k",
        ExpressionAttributeValues: { ":k": key, ":ts": now() },
      }),
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
const releaseJob = (name) =>
  db
    .send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `JOB#${name}`, SK: "STATE" },
      }),
    )
    .catch(() => {});

// Varsel til admin om oppgaver ingen har tatt (én gang per oppgave)
async function untakenAlerts(settings) {
  if (!settings.untakenAlertDays || !settings.adminChannelId) return 0;
  const cutoff = new Date(
    Date.now() - settings.untakenAlertDays * 86400000,
  ).toISOString();
  const open = await queryAll({
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "TASKSTATUS#open" },
  });
  const stale = open.filter(
    (t) => t.filledSlots === 0 && t.createdAt < cutoff && !t.alertedAt,
  );
  const claimed = [];
  for (const t of stale) {
    try {
      await db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: taskKey(t.id),
          UpdateExpression: "SET alertedAt = :ts",
          ConditionExpression: "attribute_not_exists(alertedAt)",
          ExpressionAttributeValues: { ":ts": now() },
        }),
      );
      claimed.push(t);
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  if (!claimed.length) return 0;
  const lines = claimed
    .slice(0, 15)
    .map((t) => `• **${t.title}** (${t.points} poeng)`);
  await postToChannel(settings.adminChannelId, {
    content: `⏰ Ingen har tatt disse oppgavene på ${settings.untakenAlertDays} dager:\n${lines.join("\n")}\nKanskje de trenger mer poeng, en påminnelse eller en omformulering?`,
    allowed_mentions: { parse: [] },
  });
  return claimed.length;
}

async function runNightly() {
  const today = todayOslo();
  const settings = await loadSettings();
  let created = 0;
  for (const tpl of await listTemplates()) {
    if (await spawnFromTemplate(tpl, today)) created++;
  }
  const alerts = await untakenAlerts(settings);
  return { created, alerts };
}

async function runWeekly() {
  const today = todayOslo();
  const settings = await loadSettings();
  const channel = settings.summaryChannelId || settings.adminChannelId;
  if (!channel) return { skipped: "ingen kanal satt" };
  if (!(await claimJob("weekly", isoWeekKey(today))))
    return { skipped: "kjørte allerede" };

  try {
    const lastWeek = isoWeekKey(addDays(today, -7));
    const [done, open] = await Promise.all([
      queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :p",
        ExpressionAttributeValues: { ":p": `APPROVED#${lastWeek}` },
      }),
      queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :p",
        ExpressionAttributeValues: { ":p": "TASKSTATUS#open" },
      }),
    ]);

    const parts = [];
    if (done.length) {
      const points = done.reduce((sum, c) => sum + (c.pointsAwarded ?? 0), 0);
      parts.push(
        `✅ **${done.length}** oppgave${done.length === 1 ? "" : "r"} ble fullført forrige uke, til sammen ${points} poeng. Så bra!`,
      );
      const byUser = new Map();
      for (const c of done)
        byUser.set(c.userId, (byUser.get(c.userId) ?? 0) + 1);
      const top = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      parts.push(
        `🌟 **Takk til**\n${top.map(([u, n]) => `• <@${u}> (${n} oppgave${n === 1 ? "" : "r"})`).join("\n")}`,
      );
    } else {
      parts.push(
        "Det var en rolig uke uten godkjente oppgaver. Ny uke, nye muligheter! 🙂",
      );
    }

    const remaining = open.filter((t) => t.filledSlots < t.slots);
    if (remaining.length) {
      const lines = remaining.slice(0, 10).map((t) => {
        const free = t.slots - t.filledSlots;
        return `• **${t.title}** – ${free} ledig${free === 1 ? "" : "e"}${t.deadline ? ` (frist ${fmtDate(t.deadline)})` : ""}`;
      });
      if (remaining.length > 10) lines.push(`…og ${remaining.length - 10} til`);
      parts.push(
        `📋 **Dette gjenstår**\n${lines.join("\n")}\nTa en med \`/oppgaver\`!`,
      );
    } else {
      parts.push("📋 Alle oppgaver er tatt. Flott jobba! 🎉");
    }

    await postToChannel(channel, {
      embeds: [
        {
          title: `Ukesoppsummering (${lastWeek})`,
          description: parts.join("\n\n").slice(0, 4000),
          color: 0x5865f2,
        },
      ],
      allowed_mentions: { parse: [] },
    });
    return { done: done.length, remaining: remaining.length };
  } catch (err) {
    await releaseJob("weekly"); // la en ny kjøring prøve igjen
    throw err;
  }
}

/* ---------- Maler ---------- */

async function cmdMalNy(i, opts, userId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const { intervall, dag } = opts;
  if (intervall === "weekly" && (dag < 1 || dag > 7))
    return ephemeral(
      "For ukentlige maler må `dag` være 1–7 (1 = mandag, 7 = søndag).",
    );
  if (intervall !== "weekly" && (dag < 1 || dag > 28))
    return ephemeral("For månedlige og kvartalsvise maler må `dag` være 1–28.");

  const settings = await loadSettings();
  const size = opts["størrelse"];
  const id = randomBytes(4).toString("hex");
  const tpl = {
    ...templateKey(id),
    entity: "TEMPLATE",
    id,
    title: opts.tittel,
    description: opts.beskrivelse,
    size,
    points: opts.poeng ?? settings[SIZE_SETTING[size]],
    slots: opts.plasser ?? 1,
    interval: intervall,
    anchorDay: dag,
    dueDays: opts.fristdager,
    rotation: "none", // rotasjon er ikke innført ennå
    createdBy: userId,
    createdAt: now(),
    GSI1PK: "TEMPLATES",
    GSI1SK: id,
  };
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: tpl,
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  const spawned = await spawnFromTemplate(tpl, todayOslo());
  return ephemeral(
    `✅ Mal **${tpl.title}** opprettet (${INTERVALS[intervall]}, ${describeSchedule(tpl)}). ` +
      (spawned
        ? "Oppgaven for denne perioden er allerede lagt ut."
        : "Første oppgave legges ut automatisk når perioden starter."),
  );
}

async function cmdMalListe(i) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const templates = await listTemplates();
  if (!templates.length)
    return ephemeral("Ingen maler ennå. Lag en med `/mal-ny`.");
  const lines = templates.map(
    (t) =>
      `• **${t.title}** · ${INTERVALS[t.interval]}, ${describeSchedule(t)} · ${SIZES[t.size]} · ${t.points} poeng · ${t.slots} plass${t.slots === 1 ? "" : "er"}`,
  );
  return ephemeral(`**Maler**\n${lines.join("\n")}`.slice(0, 1990));
}

async function cmdMalSlett(i, opts) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  try {
    await db.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: templateKey(opts.mal),
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return ephemeral("Fant ikke den malen. Velg en fra listen.");
    throw err;
  }
  return ephemeral(
    "🗑️ Malen er slettet. Oppgaver som allerede er lagt ut, blir liggende.",
  );
}

/* ---------- Møter og oppmøte ---------- */

const meetingKey = (id) => ({ PK: `MEETING#${id}`, SK: "META" });
const attendeeKey = (id, uid) => ({
  PK: `MEETING#${id}`,
  SK: `ATTENDEE#${uid}`,
});

function renderMeeting(m) {
  const ts = Math.floor(Date.parse(m.startsAt) / 1000);
  return {
    embeds: [
      {
        title: `📅 ${m.title}`,
        description:
          `🕒 <t:${ts}:F> (<t:${ts}:R>)\n` +
          `👥 ${m.filledSlots} av ${m.slots} plasser er tatt\n` +
          `📍 ${m.attendedCount ?? 0} har sjekket inn`,
        color: 0x5865f2,
        footer: {
          text: "Meld deg på på forhånd, og sjekk inn med knappen når møtet er i gang.",
        },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          button(1, "🙋 Meld meg på", `mt_join:${m.id}`),
          button(2, "Meld meg av", `mt_leave:${m.id}`),
          button(3, "📍 Jeg er her", `mt_here:${m.id}`),
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function cmdMote(i, opts, userId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(opts.dato) ||
    Number.isNaN(Date.parse(opts.dato))
  )
    return ephemeral("Bruk datoformatet ÅÅÅÅ-MM-DD, f.eks. 2026-11-20.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(opts.klokkeslett))
    return ephemeral("Bruk klokkeslett som TT:MM, f.eks. 18:30 (norsk tid).");
  const startsAt = osloLocalToIso(opts.dato, opts.klokkeslett);
  if (Date.parse(startsAt) < Date.now())
    return ephemeral("Tidspunktet er i fortiden.");

  const id = randomBytes(4).toString("hex");
  const meeting = {
    ...meetingKey(id),
    entity: "MEETING",
    id,
    title: opts.tittel,
    slots: opts.plasser ?? 20,
    filledSlots: 0,
    attendedCount: 0,
    startsAt,
    createdBy: userId,
    createdAt: now(),
  };
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: meeting,
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  // Postes som vanlig bot-melding (ikke interaksjonssvar), så den kan redigeres senere
  try {
    await postToChannel(i.channel_id, renderMeeting(meeting));
  } catch (err) {
    console.error("Kunne ikke poste møtemelding", err.message);
    return ephemeral(
      "Møtet er lagret, men jeg fikk ikke postet i denne kanalen. Gi meg tillatelsen *Send Messages* her.",
    );
  }
  return ephemeral("✅ Møtet er opprettet og lagt ut i kanalen.");
}

async function meetingJoin(meetingId, userId) {
  const m = await getItem(meetingKey(meetingId));
  if (!m) return "Fant ikke møtet.";
  const settings = await loadSettings();
  if (
    Date.now() >
    Date.parse(m.startsAt) + settings.meetingCheckinAfterMin * 60000
  )
    return "Det møtet er over 🙂";
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: meetingKey(meetingId),
        UpdateExpression: "ADD #fs :one",
        ConditionExpression: "#fs < #sl",
        ExpressionAttributeNames: { "#fs": "filledSlots", "#sl": "slots" },
        ExpressionAttributeValues: { ":one": 1 },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          ...attendeeKey(meetingId, userId),
          entity: "ATTENDEE",
          meetingId,
          userId,
          attended: false,
          joinedAt: now(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ]);
  if (r.ok)
    return `🙌 Du er påmeldt **${m.title}**. Husk å trykke «Jeg er her» når du møter opp!`;
  if (failedAt(r, 1)) return "Du er allerede påmeldt 🙂";
  return "Møtet er fullt, beklager!";
}

async function meetingLeave(meetingId, userId) {
  const att = await getItem(attendeeKey(meetingId, userId));
  if (!att) return "Du er ikke påmeldt det møtet.";
  if (att.attended)
    return "Du har allerede sjekket inn, så du kan ikke melde deg av.";
  const r = await transact([
    {
      Delete: {
        TableName: TABLE,
        Key: attendeeKey(meetingId, userId),
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(#at) OR #at = :f)",
        ExpressionAttributeNames: { "#at": "attended" },
        ExpressionAttributeValues: { ":f": false },
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: meetingKey(meetingId),
        UpdateExpression: "ADD #fs :m",
        ConditionExpression: "#fs > :zero",
        ExpressionAttributeNames: { "#fs": "filledSlots" },
        ExpressionAttributeValues: { ":m": -1, ":zero": 0 },
      },
    },
  ]);
  return r.ok
    ? "👋 Du er meldt av. Takk for beskjed!"
    : "Noe skjedde samtidig. Prøv igjen 🙂";
}

async function meetingHere(meetingId, userId) {
  const [m, att, settings] = await Promise.all([
    getItem(meetingKey(meetingId)),
    getItem(attendeeKey(meetingId, userId)),
    loadSettings(),
  ]);
  if (!m) return "Fant ikke møtet.";
  const start = Date.parse(m.startsAt);
  const opens = start - settings.meetingCheckinBeforeMin * 60000;
  if (Date.now() < opens)
    return `Det er litt tidlig 🙂 Innsjekk åpner <t:${Math.floor(opens / 1000)}:R>.`;
  if (Date.now() > start + settings.meetingCheckinAfterMin * 60000)
    return "Innsjekken for det møtet er stengt.";
  if (!att) return "Du må melde deg på først (knappen «Meld meg på»).";
  if (att.attended) return "Du er allerede sjekket inn ✅";

  const items = [
    {
      Update: {
        TableName: TABLE,
        Key: attendeeKey(meetingId, userId),
        UpdateExpression: "SET #at = :t, attendedAt = :ts",
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(#at) OR #at = :f)",
        ExpressionAttributeNames: { "#at": "attended" },
        ExpressionAttributeValues: { ":t": true, ":f": false, ":ts": now() },
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: meetingKey(meetingId),
        UpdateExpression: "ADD attendedCount :one",
        ExpressionAttributeValues: { ":one": 1 },
      },
    },
  ];
  if (settings.meetingPoints > 0) {
    items.push(
      ...pointsOps({
        userId,
        delta: settings.meetingPoints,
        reason: `Oppmøte: ${m.title}`,
        givenBy: "system",
      }),
    );
  }
  const r = await transact(items);
  if (!r.ok) return "Du er allerede sjekket inn ✅";
  return `✅ Du er sjekket inn på **${m.title}**${settings.meetingPoints > 0 ? ` og fikk ${settings.meetingPoints} poeng` : ""}. Fint at du kom! 💙`;
}

/* ---------- Forslag til oppgaver ---------- */

const suggestionKey = (id) => ({ PK: `SUGGESTION#${id}`, SK: "META" });
const SIZE_ALIASES = {
  lite: "small",
  liten: "small",
  small: "small",
  middels: "medium",
  medium: "medium",
  stort: "large",
  stor: "large",
  large: "large",
};

const textInputRow = (
  custom_id,
  label,
  { style = 1, required = false, max_length, placeholder } = {},
) => ({
  type: 1,
  components: [
    { type: 4, custom_id, label, style, required, max_length, placeholder },
  ],
});
const modalValue = (i, id) =>
  i.data.components
    ?.flatMap((r) => r.components)
    .find((c) => c.custom_id === id)
    ?.value?.trim() ?? "";

async function cmdForesla(i, opts, userId) {
  const settings = await loadSettings();
  if (!settings.adminChannelId)
    return ephemeral(
      "Admin-kanalen er ikke satt opp ennå. Be en admin bruke `/innstillinger`.",
    );
  const id = randomBytes(4).toString("hex");
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...suggestionKey(id),
        entity: "SUGGESTION",
        id,
        title: opts.tittel,
        description: opts.beskrivelse,
        userId,
        status: "pending",
        createdAt: now(),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  try {
    await postToChannel(settings.adminChannelId, {
      content: `💡 Nytt oppgaveforslag fra <@${userId}>`,
      allowed_mentions: { parse: [] },
      embeds: [
        { title: opts.tittel, description: opts.beskrivelse, color: 0xfee75c },
      ],
      components: [
        {
          type: 1,
          components: [
            button(3, "✅ Godkjenn og publiser", `sg_ok:${id}`),
            button(4, "❌ Avslå", `sg_no:${id}`),
          ],
        },
      ],
    });
  } catch (err) {
    console.error("Kunne ikke poste forslag", err);
    await db
      .send(new DeleteCommand({ TableName: TABLE, Key: suggestionKey(id) }))
      .catch(() => {});
    return ephemeral(
      "Jeg klarte ikke å sende forslaget akkurat nå. Prøv igjen om litt 🙏",
    );
  }
  return ephemeral(
    "💡 Takk for forslaget! En admin eller leder ser på det snart.",
  );
}

function suggestionOpenModal(action, sugId) {
  if (action === "sg_ok") {
    return json({
      type: 9,
      data: {
        custom_id: `sg_ok_modal:${sugId}`,
        title: "Godkjenn forslag",
        components: [
          textInputRow("size", "Størrelse (lite, middels eller stort)", {
            required: true,
            max_length: 10,
          }),
          textInputRow("points", "Poeng (tom = standard for størrelsen)", {
            max_length: 5,
          }),
          textInputRow("slots", "Antall plasser (tom = 1)", { max_length: 2 }),
        ],
      },
    });
  }
  return json({
    type: 9,
    data: {
      custom_id: `sg_no_modal:${sugId}`,
      title: "Avslå forslag",
      components: [
        textInputRow("comment", "Kommentar til forslagsstiller (valgfri)", {
          style: 2,
          max_length: 500,
        }),
      ],
    },
  });
}

async function suggestionApprove(i, sugId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const size = SIZE_ALIASES[modalValue(i, "size").toLowerCase()];
  if (!size)
    return ephemeral(
      "Skriv lite, middels eller stort. Forslaget er ikke behandlet ennå, så trykk Godkjenn og prøv igjen.",
    );
  const settings = await loadSettings();
  const pointsRaw = modalValue(i, "points");
  const slotsRaw = modalValue(i, "slots");
  if (
    (pointsRaw && !/^\d{1,5}$/.test(pointsRaw)) ||
    (slotsRaw && !/^\d{1,2}$/.test(slotsRaw))
  )
    return ephemeral(
      "Poeng og plasser må være hele tall. Trykk Godkjenn og prøv igjen.",
    );
  const slots = slotsRaw ? Number(slotsRaw) : 1;
  if (slots < 1 || slots > 50)
    return ephemeral("Plasser må være 1–50. Trykk Godkjenn og prøv igjen.");
  const points = pointsRaw ? Number(pointsRaw) : settings[SIZE_SETTING[size]];

  const sug = await getItem(suggestionKey(sugId));
  if (!sug) return ephemeral("Fant ikke forslaget.");
  const reviewer = userOf(i).id;
  const task = buildTaskItem({
    title: sug.title,
    description: sug.description,
    size,
    points,
    slots,
    createdBy: reviewer,
  });
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: suggestionKey(sugId),
        UpdateExpression:
          "SET #st = :a, reviewedBy = :by, reviewedAt = :ts, taskId = :t",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":a": "approved",
          ":p": "pending",
          ":by": reviewer,
          ":ts": now(),
          ":t": task.id,
        },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: task,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ]);
  if (!r.ok) return ephemeral("Dette forslaget er allerede behandlet.");

  await tryDM(sug.userId, {
    content: `🎉 Forslaget ditt **${sug.title}** ble godkjent og er lagt ut som oppgave (${points} poeng). Takk for ideen!`,
  });
  return updateMessage({
    content: `✅ Godkjent av <@${reviewer}> og publisert som oppgave (${SIZES[size]}, ${points} poeng, ${slots} plass${slots === 1 ? "" : "er"})`,
    embeds: i.message?.embeds ?? [],
    components: [],
  });
}

async function suggestionReject(i, sugId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const sug = await getItem(suggestionKey(sugId));
  if (!sug) return ephemeral("Fant ikke forslaget.");
  const reviewer = userOf(i).id;
  const comment = modalValue(i, "comment");
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: suggestionKey(sugId),
        UpdateExpression:
          "SET #st = :r, reviewedBy = :by, reviewedAt = :ts, #cm = :cm",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status", "#cm": "comment" },
        ExpressionAttributeValues: {
          ":r": "rejected",
          ":p": "pending",
          ":by": reviewer,
          ":ts": now(),
          ":cm": comment,
        },
      },
    },
  ]);
  if (!r.ok) return ephemeral("Dette forslaget er allerede behandlet.");
  await tryDM(sug.userId, {
    content:
      `Takk for at du foreslo **${sug.title}**! Vi tar den ikke inn akkurat nå.` +
      (comment ? `\n> ${comment}` : "") +
      `\nKom gjerne med flere ideer 💙`,
  });
  return updateMessage({
    content: `❌ Avslått av <@${reviewer}>${comment ? `: ${comment}` : ""}`,
    embeds: i.message?.embeds ?? [],
    components: [],
  });
}

/* ============================================================
 * Lambda-handler
 * ============================================================ */

export const handler = async (event) => {
  // Planlagt jobb fra EventBridge (Scheduler: input {"job":"checkin"})
  if (event.job || event.source === "aws.events") {
    return runJob(event.job ?? "checkin");
  }

  // HTTP fra Discord (Lambda Function URL)
  if (!event.body) return { statusCode: 400, body: "missing body" };
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
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

  try {
    switch (interaction.type) {
      case 1: // PING
        return json({ type: 1 });
      case 2: // slash-kommando
        return await handleCommand(interaction);
      case 3: // knapp
        return await handleComponent(interaction);
      case 4: // autocomplete
        return await handleAutocomplete(interaction);
      case 5: // modal
        return await handleModal(interaction);
      default:
        return { statusCode: 400, body: "unhandled interaction type" };
    }
  } catch (err) {
    console.error(err);
    if (interaction.type === 4) return json({ type: 8, data: { choices: [] } });
    return ephemeral("Oi, noe gikk galt. Prøv igjen om litt 🙏");
  }
};
