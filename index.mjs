// Frivillig-bot for gamingsenter – Lambda-handler (fase 1–6)
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
  ScanCommand,
  BatchGetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomBytes, randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";

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
  // Nivåer (nivå beregnes av totalEarned). Plassholdere – sett dine egne.
  levelVeteranPoints: 100,
  levelLegendPoints: 500,
  roleRecruitId: null,
  roleVeteranId: null,
  roleLegendId: null,
  // Streak og multiplikator: bonuser summeres og kappes på multiplierCap
  streakStep: 0.1, // +0,1 per streak-uke
  streakMax: 0.5, // maks streak-bonus (×1,5 etter 5 uker)
  multiplierCap: 1.5,
  // Takk, idé, ny gjest
  thanksPoints: 2,
  thanksMaxPerWeek: 3,
  ideaPoints: 20,
  guestPoints: 15,
  guestMaxPerWeek: 3,
  // Toppliste og kanaler
  leaderboardEnabled: 0, // 1 = på
  photoChannelId: process.env.PHOTO_CHANNEL_ID ?? null,
  volunteerRoleId: process.env.VOLUNTEER_ROLE_ID ?? null, // satt = man må ha rollen for å samle poeng
  volunteerChannelId: null, // settes automatisk av /frivillig-knapp
  photoMaxMb: 9.5, // største bilde boten laster opp på nytt (Discord: ca. 10 uten serverboost)
  shoutoutChannelId: process.env.SHOUTOUT_CHANNEL_ID ?? null,
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
  levelVeteranPoints: {
    type: "int",
    min: 1,
    max: 100000,
    label: "Nivå Veteran: poeng som kreves",
  },
  levelLegendPoints: {
    type: "int",
    min: 1,
    max: 100000,
    label: "Nivå Legende: poeng som kreves",
  },
  roleRecruitId: { type: "id", label: "Discord-rolle: Rekrutt" },
  roleVeteranId: { type: "id", label: "Discord-rolle: Veteran" },
  roleLegendId: { type: "id", label: "Discord-rolle: Legende" },
  streakStep: {
    type: "float",
    min: 0,
    max: 1,
    label: "Streak: bonus per uke (f.eks. 0,1)",
  },
  streakMax: {
    type: "float",
    min: 0,
    max: 4,
    label: "Streak: maks bonus (f.eks. 0,5)",
  },
  multiplierCap: {
    type: "float",
    min: 1,
    max: 5,
    label: "Multiplikator: maks totalt (f.eks. 1,5)",
  },
  thanksPoints: { type: "int", min: 0, max: 1000, label: "Poeng per takk" },
  thanksMaxPerWeek: {
    type: "int",
    min: 1,
    max: 50,
    label: "Maks takk man kan gi per uke",
  },
  ideaPoints: {
    type: "int",
    min: 0,
    max: 10000,
    label: "Standardpoeng for idé tatt i bruk",
  },
  guestPoints: {
    type: "int",
    min: 0,
    max: 10000,
    label: "Poeng for ny ordinær besøkende",
  },
  guestMaxPerWeek: {
    type: "int",
    min: 1,
    max: 50,
    label: "Maks gjester man kan melde per uke",
  },
  leaderboardEnabled: {
    type: "int",
    min: 0,
    max: 1,
    label: "Toppliste (1 = på, 0 = av)",
  },
  photoChannelId: { type: "id", label: "Bildekanal (#før-og-etter)" },
  volunteerRoleId: {
    type: "id",
    label: "Discord-rolle: Frivillig (påkrevd for å samle poeng)",
  },
  volunteerChannelId: {
    type: "id",
    label: "Kanal med «Bli frivillig»-knappen (settes automatisk)",
  },
  photoMaxMb: {
    type: "float",
    min: 1,
    max: 100,
    label: "Bilde: maks størrelse i MB (ca. 10 uten serverboost)",
  },
  shoutoutChannelId: { type: "id", label: "Kanal for månedens frivillige" },
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

async function discord(
  path,
  { method = "GET", body, form, retry = true, timeout = 5000 } = {},
) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      ...(form ? {} : { "Content-Type": "application/json" }),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 429 && retry) {
    const { retry_after = 1 } = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, Math.min(retry_after, 5) * 1000));
    return discord(path, { method, body, form, retry: false, timeout });
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
    for (const item of r.Items ?? []) items.push(item);
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

// Poeng: atomisk saldo + loggrad + månedsteller (til månedens frivillige/topplisten).
// `streak` (valgfri) oppdaterer streak-feltene på brukeren i samme operasjon.
function pointsOps({
  userId,
  delta,
  basePoints = delta,
  multiplier = 1,
  reason,
  givenBy,
  taskId,
  streak,
}) {
  const ts = now();
  const sets = ["createdAt = if_not_exists(createdAt, :ts)"];
  const values = { ":ts": ts, ":d": delta };
  if (streak) {
    sets.push(
      "attendanceStreak = :sv",
      "lastStreakWeek = :sw",
      "lastStreakMonday = :sm",
    );
    values[":sv"] = streak.value;
    values[":sw"] = streak.week;
    values[":sm"] = streak.monday;
  }
  const update = {
    Update: {
      TableName: TABLE,
      Key: userKey(userId),
      UpdateExpression: `SET ${sets.join(", ")} ADD #pts :d, totalEarned :d`,
      ExpressionAttributeNames: { "#pts": "points" },
      ExpressionAttributeValues: values,
    },
  };
  if (delta < 0) {
    update.Update.ConditionExpression = "#pts >= :min";
    update.Update.ExpressionAttributeValues[":min"] = -delta;
  }
  const ops = [update];
  if (delta !== 0) {
    ops.push({
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
    });
    ops.push({
      Update: {
        TableName: TABLE,
        Key: { PK: `MONTH#${todayOslo().slice(0, 7)}`, SK: `USER#${userId}` },
        UpdateExpression: "SET userId = :u ADD earned :d",
        ExpressionAttributeValues: { ":u": userId, ":d": delta },
      },
    });
  }
  return ops;
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
  const gate = await loadSettings();
  if (!isVolunteer(i, gate)) return notVolunteerReply(gate);
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
          photoWidth: attachment?.width,
          photoHeight: attachment?.height,
          photoSize: attachment?.size,
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

  const award = await computeAward(userId, task.points ?? 0, {
    attendance: true,
  });
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
          ":pts": award.delta,
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
  items.push(
    ...pointsOps({
      userId,
      delta: award.delta,
      basePoints: award.basePoints,
      multiplier: award.multiplier,
      streak: award.streakUpdate,
      reason: `Fullført oppgave: ${task.title}`,
      givenBy: reviewerId,
      taskId,
    }),
  );

  const r = await transact(items);
  if (!r.ok)
    return { ok: false, handled: true, text: "Denne er allerede behandlet." };

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

  return {
    ok: true,
    task,
    award,
    photoUrl: completion.photoUrl,
    photoMeta: {
      width: completion.photoWidth,
      height: completion.photoHeight,
      size: completion.photoSize,
    },
  };
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
  if (!r.ok)
    return { ok: false, handled: true, text: "Denne er allerede behandlet." };
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

async function runJob(job, event = {}) {
  switch (job) {
    case "checkin":
      return runCheckins();
    case "nightly":
      return runNightly();
    case "weekly":
      return runWeekly();
    case "monthly":
      return runMonthly();
    case "afterApproval":
      return runAfterApproval(event);
    case "taskEdited":
      return runTaskEdited(event);
    case "export":
      return runExport(event);
    case "grantRole":
      return runGrantRole(event);
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
  const [profile, settings] = await Promise.all([
    getItem(userKey(userId)),
    loadSettings(),
  ]);
  if (!profile)
    return ephemeral(
      "Du har ikke fått poeng ennå. Ta en oppgave med `/oppgaver` 💪",
    );
  const total = profile.totalEarned ?? 0;
  const level = levelFor(total, settings);
  const next = LEVELS[levelRank(level.key) + 1];
  const streak = effectiveStreak(profile, todayOslo(), settings);
  const mult = multiplierFor(streak, settings);

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
    .map((l) => {
      const how =
        l.multiplier > 1 ? ` (${l.basePoints} × ${fmtMult(l.multiplier)})` : "";
      return `${l.delta > 0 ? "+" : ""}${l.delta}${how} · ${l.reason} · ${discordTime(l.createdAt)}`;
    })
    .join("\n");

  const lines = [
    `⭐ Du har **${profile.points ?? 0} poeng**.`,
    `🏅 Nivå: **${level.name}**${next ? ` (${Math.max(0, settings[next.min] - total)} poeng til ${next.name})` : ""}`,
    `🔥 Streak: **${streak} uke${streak === 1 ? "" : "r"}**, multiplikator **×${fmtMult(mult)}**`,
  ];
  return ephemeral(
    lines.join("\n") + (recent ? `\n\n**Siste endringer**\n${recent}` : ""),
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
  await withTimeout(syncLevel(opts.bruker), 1500);
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
    return message({
      flags: 64,
      embeds: [
        {
          title: "Innstillinger",
          description:
            `${lines.join("\n")}\n\nEndre med \`/innstillinger innstilling:… verdi:…\``.slice(
              0,
              4000,
            ),
          color: 0x5865f2,
        },
      ],
    });
  }

  const def = SETTING_DEFS[opts.innstilling];
  if (!def) return ephemeral("Ukjent innstilling.");
  if (opts.verdi == null || opts.verdi === "")
    return ephemeral("Oppgi også en verdi.");

  let value;
  if (def.type === "float") {
    const normalized = opts.verdi.replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(normalized))
      return ephemeral("Verdien må være et tall, f.eks. 0,1.");
    value = Number(normalized);
    if (value < def.min || value > def.max)
      return ephemeral(
        `Verdien må være mellom ${fmtMult(def.min)} og ${fmtMult(def.max)}.`,
      );
  } else if (def.type === "int") {
    if (!/^\d+$/.test(opts.verdi))
      return ephemeral("Verdien må være et heltall.");
    value = Number(opts.verdi);
    if (value < def.min || value > def.max)
      return ephemeral(`Verdien må være mellom ${def.min} og ${def.max}.`);
  } else {
    if (
      ["ingen", "-", "av", "fjern"].includes(opts.verdi.trim().toLowerCase())
    ) {
      value = null; // fjerner innstillingen (standardverdi/miljøvariabel brukes igjen)
    } else {
      const m = opts.verdi.trim().match(/^(?:<[#@&]*)?(\d{5,25})>?$/); // ID, #kanal eller @rolle
      if (!m)
        return ephemeral(
          "Oppgi en ID (eller lim inn #kanal / @rolle). Skriv `ingen` for å fjerne innstillingen.",
        );
      value = m[1];
    }
  }

  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "CONFIG", SK: "SETTINGS" },
      UpdateExpression:
        value === null
          ? "REMOVE #k SET updatedAt = :ts"
          : "SET #k = :v, updatedAt = :ts",
      ExpressionAttributeNames: { "#k": opts.innstilling },
      ExpressionAttributeValues:
        value === null ? { ":ts": now() } : { ":v": value, ":ts": now() },
    }),
  );
  if (value === null) return ephemeral(`✅ ${def.label}: fjernet.`);
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
  "oppgave-rediger": cmdOppgaveRediger,
  eksport: cmdEksport,
  "frivillig-knapp": cmdFrivilligKnapp,
  "møtemal-ny": cmdMoteMalNy,
  "møtemal-liste": cmdMoteMalListe,
  "møtemal-slett": cmdMoteMalSlett,
  "frivillig-synk": cmdFrivilligSynk,
  takk: cmdTakk,
  ide: cmdIde,
  "ny-gjest": cmdNyGjest,
  leaderboard: cmdLeaderboard,
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
  } else if (
    (i.data.name === "oppgave-slett" && isAdmin(i)) ||
    (i.data.name === "oppgave-rediger" && canManage(i))
  ) {
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
  if (i.data.name === "møtemal-slett" && isAdmin(i)) {
    tasks = await listMeetingTemplates();
  }
  if (i.data.name === "innstillinger") {
    const settingChoices = isAdmin(i)
      ? Object.entries(SETTING_DEFS)
          .filter(
            ([key, def]) =>
              def.label.toLowerCase().includes(typed) ||
              key.toLowerCase().includes(typed),
          )
          .slice(0, 25)
          .map(([key, def]) => ({ name: def.label.slice(0, 100), value: key }))
      : [];
    return json({ type: 8, data: { choices: settingChoices } });
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
      const gate = await loadSettings();
      if (!isVolunteer(i, gate)) return notVolunteerReply(gate);
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
      if (!r.ok) {
        // Allerede behandlet: fjern knappene så meldingen ikke blir stående igjen
        if (r.handled)
          return updateMessage({
            content: "✔️ Denne ferdigmeldingen er allerede behandlet.",
            embeds: i.message?.embeds ?? [],
            components: [],
          });
        return ephemeral(r.text);
      }
      const after = await afterApproval(r, targetId);
      const photoNote = after.wantsPhoto
        ? after.queued
          ? " · 📸 bilde sendes til bildekanalen"
          : " · ⚠️ bildet ble ikke publisert (bakgrunnsjobb mangler, se oppsett)"
        : after.noChannel
          ? " · ℹ️ bildet ble ikke publisert fordi bildekanalen ikke er satt (/innstillinger)"
          : "";
      return updateMessage({
        content: `✅ Godkjent av <@${user.id}> · <@${targetId}> fikk ${r.award.delta} poeng for **${r.task.title}**${awardNote(r.award)}${photoNote}`,
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
      if (action !== "mt_leave") {
        const gate = await loadSettings();
        if (!isVolunteer(i, gate)) return notVolunteerReply(gate);
      }
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

    case "join_vol":
      return joinVolunteer(i);

    case "leave_vol":
      return leaveVolunteer(i);

    case "idea_use":
      if (!canManage(i)) return ephemeral(NO_ACCESS);
      return ideaOpenModal(taskId); // taskId = idé-ID her

    case "idea_arch":
      return ideaArchive(i, taskId);

    case "guest_ok":
      return guestConfirm(i, taskId); // taskId = gjest-ID her

    case "guest_no":
      return guestReject(i, taskId);

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
  if (action === "idea_use_modal") return ideaUse(i, taskId);
  if (action === "sg_ok_modal") return suggestionApprove(i, taskId);
  if (action === "sg_no_modal") return suggestionReject(i, taskId);
  if (action !== "reject_modal") return ephemeral("Ukjent skjema.");
  const user = userOf(i);
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  if (targetId === user.id && !isAdmin(i))
    return ephemeral("Du kan ikke avslå din egen ferdigmelding 🙂");

  const comment = i.data.components?.[0]?.components?.[0]?.value?.trim() ?? "";
  const r = await rejectCompletion(taskId, targetId, user.id, comment);
  if (!r.ok) {
    if (r.handled)
      return updateMessage({
        content: "✔️ Denne ferdigmeldingen er allerede behandlet.",
        embeds: i.message?.embeds ?? [],
        components: [],
      });
    return ephemeral(r.text);
  }

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
  let meetings = 0;
  const failed = [];
  for (const tpl of await listMeetingTemplates()) {
    const r = await spawnMeetingFromTemplate(tpl);
    if (r?.meeting) meetings++;
    else if (r?.error)
      failed.push(
        `• **${tpl.title}** i <#${tpl.channelId}>: ${channelErrorHint(r.error)}`,
      );
  }
  if (failed.length && settings.adminChannelId) {
    await postToChannel(settings.adminChannelId, {
      content:
        `⚠️ Jeg fikk ikke lagt ut møter fra mal i natt. Jeg prøver igjen i morgen.\n${failed.join("\n")}`.slice(
          0,
          1990,
        ),
      allowed_mentions: { parse: [] },
    }).catch(() => {});
  }
  const alerts = await untakenAlerts(settings);
  return { created, meetings, alerts };
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
          `👥 ${m.slots == null ? `${m.filledSlots} påmeldt` : `${m.filledSlots} av ${m.slots} plasser er tatt`}\n` +
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
  // Dato er valgfri og settes til i dag (norsk tid) hvis den utelates
  const dato = opts.dato ?? todayOslo();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dato) || Number.isNaN(Date.parse(dato)))
    return ephemeral("Bruk datoformatet ÅÅÅÅ-MM-DD, f.eks. 2026-11-20.");
  // Tillat «18:30», «9:30» og «18.30»
  const time = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(opts.klokkeslett.trim());
  if (!time)
    return ephemeral("Bruk klokkeslett som TT:MM, f.eks. 18:30 (norsk tid).");
  const startsAt = osloLocalToIso(dato, `${pad(Number(time[1]))}:${time[2]}`);
  if (Date.parse(startsAt) < Date.now())
    return ephemeral(
      opts.dato
        ? "Tidspunktet er i fortiden."
        : "Det klokkeslettet har allerede vært i dag. Legg til `dato` hvis møtet er en annen dag (ÅÅÅÅ-MM-DD).",
    );

  const id = randomBytes(4).toString("hex");
  const meeting = {
    ...meetingKey(id),
    entity: "MEETING",
    id,
    title: opts.tittel,
    slots: opts.plasser ?? null, // null = ubegrenset
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
        ConditionExpression:
          "attribute_not_exists(#sl) OR #sl = :nul OR #fs < #sl",
        ExpressionAttributeNames: { "#fs": "filledSlots", "#sl": "slots" },
        ExpressionAttributeValues: { ":one": 1, ":nul": null },
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
  const award = await computeAward(userId, settings.meetingPoints, {
    attendance: true,
  });
  items.push(
    ...pointsOps({
      userId,
      delta: award.delta,
      basePoints: award.basePoints,
      multiplier: award.multiplier,
      streak: award.streakUpdate,
      reason: `Oppmøte: ${m.title}`,
      givenBy: "system",
    }),
  );
  const r = await transact(items);
  if (!r.ok) return "Du er allerede sjekket inn ✅";
  await withTimeout(syncLevel(userId), 1500);
  return `✅ Du er sjekket inn på **${m.title}**${award.delta > 0 ? ` og fikk ${award.delta} poeng${awardNote(award)}` : ""}. Fint at du kom! 💙`;
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
  { style = 1, required = false, max_length, placeholder, value } = {},
) => ({
  type: 1,
  components: [
    {
      type: 4,
      custom_id,
      label,
      style,
      required,
      max_length,
      placeholder,
      value,
    },
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
 * Fase 3: nivåer, streak og multiplikator
 * ============================================================ */

const MONTHS = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
];

const LEVELS = [
  { key: "recruit", name: "Rekrutt", role: "roleRecruitId" },
  {
    key: "veteran",
    name: "Veteran",
    min: "levelVeteranPoints",
    role: "roleVeteranId",
  },
  {
    key: "legend",
    name: "Legende",
    min: "levelLegendPoints",
    role: "roleLegendId",
  },
];
const levelRank = (key) => LEVELS.findIndex((l) => l.key === key);
function levelFor(total, s) {
  let current = LEVELS[0];
  for (const l of LEVELS) if (l.min && total >= s[l.min]) current = l;
  return current;
}
const fmtMult = (m) => String(m).replace(".", ",");

// Kjør noe «best effort» innen en tidsramme, så vi holder oss under Discords 3 sekunder
const withTimeout = (promise, ms, fallback = null) =>
  Promise.race([
    Promise.resolve(promise).catch((err) => {
      console.warn("withTimeout:", err.message);
      return fallback;
    }),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

const mondayOf = (dateStr) => addDays(dateStr, -(isoWeekday(dateStr) - 1));
const weeksBetween = (mondayA, mondayB) =>
  Math.round((Date.parse(mondayB) - Date.parse(mondayA)) / (7 * 86400000));
const maxStreakWeeks = (s) =>
  s.streakStep > 0 ? Math.ceil(s.streakMax / s.streakStep - 1e-9) : 0;

// Streaken slik den står i dag. Hver hele uke uten oppmøte tar den ned ett trinn.
function effectiveStreak(profile, today, s) {
  if (!profile?.lastStreakMonday) return 0;
  const base = Math.min(profile.attendanceStreak ?? 0, maxStreakWeeks(s));
  const gap = weeksBetween(profile.lastStreakMonday, mondayOf(today));
  return gap <= 1 ? base : Math.max(0, base - (gap - 1));
}

function multiplierFor(streak, s, extra = 0) {
  const m = 1 + Math.min(streak * s.streakStep, s.streakMax) + extra; // bonuser summeres
  return Math.min(s.multiplierCap, Math.round(m * 100) / 100);
}

// Regner ut multiplikator og endelige poeng, og evt. ny streak. Låses i det poengene deles ut.
async function computeAward(userId, base, { attendance }) {
  const [profile, settings] = await Promise.all([
    getItem(userKey(userId)),
    loadSettings(),
  ]);
  const today = todayOslo();
  let streak = effectiveStreak(profile, today, settings);
  let streakUpdate;
  if (attendance) {
    const thisMonday = mondayOf(today);
    if (profile?.lastStreakMonday !== thisMonday) {
      streak = Math.min(maxStreakWeeks(settings), streak + 1);
      streakUpdate = {
        value: streak,
        week: isoWeekKey(today),
        monday: thisMonday,
      };
    }
  }
  const multiplier = multiplierFor(streak, settings);
  return {
    basePoints: base,
    multiplier,
    delta: Math.round(base * multiplier),
    streakUpdate,
    streak,
  };
}

const awardNote = (a) =>
  a.multiplier > 1
    ? ` (${a.basePoints} × ${fmtMult(a.multiplier)}, streak ${a.streak} uke${a.streak === 1 ? "" : "r"})`
    : "";

// Oppdaterer nivå og Discord-roller etter poengendring. Kalles best effort.
async function syncLevel(userId) {
  const [profile, settings] = await Promise.all([
    getItem(userKey(userId)),
    loadSettings(),
  ]);
  if (!profile) return null;
  const level = levelFor(profile.totalEarned ?? 0, settings);
  if (profile.level === level.key) return null;

  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: userKey(userId),
        UpdateExpression: "SET #lv = :l",
        ConditionExpression: "attribute_not_exists(#lv) OR #lv <> :l",
        ExpressionAttributeNames: { "#lv": "level" },
        ExpressionAttributeValues: { ":l": level.key },
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }

  const guild = process.env.GUILD_ID;
  if (guild) {
    const newRole = settings[level.role];
    const oldLevel = LEVELS[levelRank(profile.level)];
    const oldRole = oldLevel ? settings[oldLevel.role] : null;
    if (newRole)
      await discord(`/guilds/${guild}/members/${userId}/roles/${newRole}`, {
        method: "PUT",
      }).catch((e) => console.warn("Kunne ikke gi rolle:", e.message));
    if (oldRole && oldRole !== newRole)
      await discord(`/guilds/${guild}/members/${userId}/roles/${oldRole}`, {
        method: "DELETE",
      }).catch((e) => console.warn("Kunne ikke fjerne rolle:", e.message));
  }

  const rose = levelRank(level.key) > levelRank(profile.level ?? "recruit");
  if (rose && (profile.level || level.key !== "recruit")) {
    await tryDM(userId, {
      content: `🎉 Du har nådd nivået **${level.name}**! Takk for alt du bidrar med 💙`,
    });
  }
  return level;
}

/* ============================================================
 * Fase 3: bilder til bildekanal
 * ============================================================ */

async function publishPhoto(photoUrl, task, settings, meta = {}) {
  const maxBytes = (settings.photoMaxMb ?? 9.5) * 1024 * 1024;

  let url = photoUrl;
  try {
    // Discord-lenker utløper, så be om en fersk
    const r = await discord("/attachments/refresh-urls", {
      method: "POST",
      body: { attachment_urls: [photoUrl] },
    });
    url = r.refreshed_urls?.[0]?.refreshed ?? photoUrl;
  } catch (err) {
    console.warn("refresh-urls feilet, bruker original-URL:", err.message);
  }

  // Samme (signerte) lenke via Discords media-proxy, skalert ned til maks 2560 px på lengste side
  const resizedUrl = (u) => {
    const x = new URL(u);
    if (x.hostname === "cdn.discordapp.com")
      x.hostname = "media.discordapp.net";
    const { width: w, height: h } = meta;
    const scale = w && h ? Math.min(1, 2560 / Math.max(w, h)) : null;
    x.searchParams.set("width", String(scale ? Math.round(w * scale) : 2560));
    x.searchParams.set("height", String(scale ? Math.round(h * scale) : 2560));
    x.searchParams.set("format", "webp");
    return x.toString();
  };
  const download = async (u) => {
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Kunne ikke hente bildet (${res.status})`);
    return {
      type: (res.headers.get("content-type") ?? "image/jpeg").split(";")[0],
      buf: Buffer.from(await res.arrayBuffer()),
    };
  };

  // Vet vi at originalen er for stor, hopper vi rett til den nedskalerte versjonen
  let usedResized = Boolean(meta.size && meta.size > maxBytes);
  let img = await download(usedResized ? resizedUrl(url) : url);
  if (img.buf.length > maxBytes && !usedResized) {
    usedResized = true;
    img = await download(resizedUrl(url));
  }
  if (img.buf.length > maxBytes)
    throw new Error(
      `Bildet er for stort, også etter nedskalering (over ${settings.photoMaxMb ?? 9.5} MB)`,
    );
  if (usedResized)
    console.log(
      `Bildet ble skalert ned til ${Math.round(img.buf.length / 1024)} KB`,
    );

  const filename = `oppgave.${img.type.split("/")[1] ?? "jpg"}`;
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      content: `✨ **${task.title}** er gjort! Takk for hjelpen 💙`,
      attachments: [{ id: 0, filename }],
      allowed_mentions: { parse: [] },
    }),
  );
  form.append("files[0]", new Blob([img.buf], { type: img.type }), filename);
  await discord(`/channels/${settings.photoChannelId}/messages`, {
    method: "POST",
    form,
    timeout: 30000,
  });
  return true;
}

// Starter en bakgrunnsjobb ved å kalle Lambdaen asynkront (svarer med en gang, jobben kjører for seg selv)
let lambdaClient;
async function dispatchAsync(payload) {
  try {
    const { LambdaClient, InvokeCommand } =
      await import("@aws-sdk/client-lambda");
    lambdaClient ??= new LambdaClient({});
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify(payload),
      }),
    );
    return true;
  } catch (err) {
    console.warn("Kunne ikke starte bakgrunnsjobb:", err.message);
    return false;
  }
}

// Alt som skjer etter at en ferdigmelding er godkjent. Tungt arbeid (bilde, DM, nivå) kjøres
// i bakgrunnen, slik at knappen svarer innen Discords 3 sekunder.
async function afterApproval(r, targetId) {
  const settings = await loadSettings();
  const wantsPhoto = Boolean(r.photoUrl && settings.photoChannelId);
  const payload = {
    job: "afterApproval",
    targetId,
    title: r.task.title,
    dm: `🎉 **${r.task.title}** er godkjent! Du fikk ${r.award.delta} poeng${awardNote(r.award)}. Takk for innsatsen!`,
    photoUrl: wantsPhoto ? r.photoUrl : undefined,
    photoMeta: r.photoMeta,
    photoMaxMb: settings.photoMaxMb,
    photoChannelId: settings.photoChannelId,
    adminChannelId: settings.adminChannelId,
  };
  const noChannel = Boolean(r.photoUrl && !settings.photoChannelId);
  if (await dispatchAsync(payload))
    return { wantsPhoto, noChannel, queued: true };

  // Reserve hvis bakgrunnsjobb ikke kunne startes: gjør det raske her, hopp over bildet
  await Promise.all([
    withTimeout(tryDM(targetId, { content: payload.dm }), 1200),
    withTimeout(syncLevel(targetId), 1200),
  ]);
  return { wantsPhoto, noChannel, queued: false };
}

function photoErrorHint(err) {
  const m = String(err.message);
  if (/\b(403|50013|50001)\b/.test(m))
    return "boten mangler tilgang i bildekanalen. Den trenger *Se kanal*, *Send meldinger* og *Legg ved filer* der.";
  if (/\b404\b|\b410\b/.test(m) && /hente bildet/.test(m))
    return "bildelenken fra Discord har utløpt eller er fjernet.";
  if (/\b10003\b/.test(m) || /Unknown Channel/i.test(m))
    return "bildekanalen finnes ikke. Sjekk kanal-ID-en i `/innstillinger`.";
  if (/for stort/.test(m))
    return "bildet er for stort til å poste på nytt, selv etter nedskalering. Be om et mindre bilde, eller øk `Bilde: maks størrelse` i `/innstillinger` hvis serveren har boost.";
  return `${m.slice(0, 200)} (se CloudWatch-loggen for detaljer)`;
}

async function runAfterApproval(p) {
  await Promise.all([
    tryDM(p.targetId, { content: p.dm }),
    syncLevel(p.targetId).catch((err) =>
      console.warn("syncLevel feilet:", err.message),
    ),
  ]);
  if (p.photoUrl && p.photoChannelId) {
    try {
      await publishPhoto(
        p.photoUrl,
        { title: p.title },
        { photoChannelId: p.photoChannelId, photoMaxMb: p.photoMaxMb },
        p.photoMeta,
      );
    } catch (err) {
      console.error("Kunne ikke publisere bilde:", err);
      if (p.adminChannelId) {
        await postToChannel(p.adminChannelId, {
          content:
            `⚠️ Bildet til **${p.title}** kunne ikke publiseres i bildekanalen <#${p.photoChannelId}>. Poengene er delt ut som vanlig.\n` +
            `Årsak: ${photoErrorHint(err)}`,
          allowed_mentions: { parse: [] },
        }).catch(() => {});
      }
    }
  }
  return { done: true };
}

/* ============================================================
 * Fase 3: /takk
 * ============================================================ */

async function cmdTakk(i, opts, userId) {
  const target = opts.bruker;
  if (target === userId)
    return ephemeral(
      "Takk til deg selv også 😄 men her deler vi ut til andre. Prøv en annen!",
    );
  if (i.data.resolved?.users?.[target]?.bot)
    return ephemeral("Boter trenger ingen poeng 🤖");

  const settings = await loadSettings();
  if (!isVolunteer(i, settings)) return notVolunteerReply(settings);
  if (
    settings.volunteerRoleId &&
    !(i.data.resolved?.members?.[target]?.roles ?? []).includes(
      settings.volunteerRoleId,
    )
  )
    return ephemeral(
      `<@${target}> er ikke frivillig ennå, så hen kan ikke få poeng. Hen kan trykke på «Bli frivillig» 🙂`,
    );
  const week = isoWeekKey(todayOslo());
  const award = await computeAward(target, settings.thanksPoints, {
    attendance: false,
  });
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `THANKS#${week}` },
        UpdateExpression: "ADD #n :one",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":max": settings.thanksMaxPerWeek,
        },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK: `USER#${userId}`,
          SK: `THANKED#${week}#${target}`,
          entity: "THANKED",
          createdAt: now(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    ...pointsOps({
      userId: target,
      delta: award.delta,
      basePoints: award.basePoints,
      multiplier: award.multiplier,
      reason: `Takk fra <@${userId}>`,
      givenBy: userId,
    }),
  ]);
  if (!r.ok) {
    if (failedAt(r, 0))
      return ephemeral(
        `Du har brukt opp ukens takk (maks ${settings.thanksMaxPerWeek} per uke). Neste uke er det nye 💙`,
      );
    if (failedAt(r, 1))
      return ephemeral("Du har allerede takket den personen denne uken 🙂");
    return ephemeral("Noe skjedde samtidig. Prøv igjen om litt 🙂");
  }
  await withTimeout(syncLevel(target), 1500);
  const melding = opts.melding ? `\n> ${opts.melding}` : "";
  return message({
    content: `💙 <@${userId}> sier takk til <@${target}>!${melding}`,
    allowed_mentions: { users: [target] },
  });
}

/* ============================================================
 * Fase 3: ideboks (anonym)
 * ============================================================ */

async function cmdIde(i, opts, userId) {
  const settings = await loadSettings();
  if (!isVolunteer(i, settings)) return notVolunteerReply(settings);
  if (!settings.adminChannelId)
    return ephemeral(
      "Admin-kanalen er ikke satt opp ennå. Be en admin bruke `/innstillinger`.",
    );
  const id = randomBytes(4).toString("hex");
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `IDEA#${id}`,
        SK: "META",
        entity: "IDEA",
        id,
        userId, // lagres internt, vises aldri i meldingen til admin
        text: opts.tekst,
        status: "new",
        createdAt: now(),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  try {
    await postToChannel(settings.adminChannelId, {
      content: "💡 Ny anonym idé",
      allowed_mentions: { parse: [] },
      embeds: [{ description: opts.tekst, color: 0xfee75c }],
      components: [
        {
          type: 1,
          components: [
            button(3, "✅ Tatt i bruk", `idea_use:${id}`),
            button(2, "📁 Arkiver", `idea_arch:${id}`),
          ],
        },
      ],
    });
  } catch (err) {
    console.error("Kunne ikke poste idé", err);
    await db
      .send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { PK: `IDEA#${id}`, SK: "META" },
        }),
      )
      .catch(() => {});
    return ephemeral(
      "Jeg klarte ikke å sende ideen akkurat nå. Prøv igjen om litt 🙏",
    );
  }
  return ephemeral(
    "💡 Takk for ideen! Den er sendt anonymt. Admin ser ikke at den er fra deg, men hvis den tas i bruk, får du poengene automatisk.",
  );
}

async function ideaOpenModal(ideaId) {
  const settings = await loadSettings();
  return json({
    type: 9,
    data: {
      custom_id: `idea_use_modal:${ideaId}`,
      title: "Idé tatt i bruk",
      components: [
        textInputRow("points", "Poeng til avsender", {
          required: true,
          max_length: 5,
          value: String(settings.ideaPoints),
        }),
      ],
    },
  });
}

async function ideaUse(i, ideaId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const raw = modalValue(i, "points");
  if (!/^\d{1,5}$/.test(raw))
    return ephemeral(
      "Poeng må være et helt tall. Trykk «Tatt i bruk» og prøv igjen.",
    );
  const idea = await getItem({ PK: `IDEA#${ideaId}`, SK: "META" });
  if (!idea) return ephemeral("Fant ikke ideen.");
  const reviewer = userOf(i).id;
  const award = await computeAward(idea.userId, Number(raw), {
    attendance: false,
  });
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `IDEA#${ideaId}`, SK: "META" },
        UpdateExpression: "SET #st = :u, reviewedBy = :by, reviewedAt = :ts",
        ConditionExpression: "#st = :n",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":u": "used",
          ":n": "new",
          ":by": reviewer,
          ":ts": now(),
        },
      },
    },
    ...pointsOps({
      userId: idea.userId,
      delta: award.delta,
      basePoints: award.basePoints,
      multiplier: award.multiplier,
      reason: "Idé tatt i bruk",
      givenBy: reviewer,
    }),
  ]);
  if (!r.ok) return ephemeral("Denne ideen er allerede behandlet.");
  await Promise.all([
    withTimeout(
      tryDM(idea.userId, {
        content: `💡 Ideen din ble tatt i bruk! Du fikk ${award.delta} poeng${awardNote(award)}. Tusen takk!\n> ${idea.text.slice(0, 200)}`,
      }),
      1800,
    ),
    withTimeout(syncLevel(idea.userId), 1800),
  ]);
  return updateMessage({
    content: `✅ Tatt i bruk (godkjent av <@${reviewer}>). Avsender er belønnet.`,
    embeds: i.message?.embeds ?? [],
    components: [],
  });
}

async function ideaArchive(i, ideaId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `IDEA#${ideaId}`, SK: "META" },
        UpdateExpression: "SET #st = :a, reviewedBy = :by, reviewedAt = :ts",
        ConditionExpression: "#st = :n",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":a": "archived",
          ":n": "new",
          ":by": userOf(i).id,
          ":ts": now(),
        },
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return ephemeral("Denne ideen er allerede behandlet.");
    throw err;
  }
  return updateMessage({
    content: `📁 Arkivert av <@${userOf(i).id}>`,
    embeds: i.message?.embeds ?? [],
    components: [],
  });
}

/* ============================================================
 * Fase 3: ny ordinær besøkende (/ny-gjest)
 * ============================================================ */

async function cmdNyGjest(i, opts, userId) {
  const settings = await loadSettings();
  if (!isVolunteer(i, settings)) return notVolunteerReply(settings);
  if (!settings.adminChannelId)
    return ephemeral(
      "Admin-kanalen er ikke satt opp ennå. Be en admin bruke `/innstillinger`.",
    );
  const week = isoWeekKey(todayOslo());
  const id = randomBytes(4).toString("hex");
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `GUESTREQ#${week}` },
        UpdateExpression: "ADD #n :one",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":max": settings.guestMaxPerWeek,
        },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK: `GUEST#${id}`,
          SK: "META",
          entity: "GUEST",
          id,
          userId,
          note: opts.merknad, // slettes når admin har tatt stilling
          status: "pending",
          createdAt: now(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ]);
  if (!r.ok)
    return ephemeral(
      `Du har allerede meldt ${settings.guestMaxPerWeek} gjester denne uka. Prøv igjen neste uke 🙂`,
    );

  try {
    await postToChannel(settings.adminChannelId, {
      content:
        `🎮 <@${userId}> melder at de har tatt med en ny besøkende.` +
        (opts.merknad ? `\nMerknad: ${opts.merknad}` : "") +
        `\nBekreft bare hvis personen faktisk møtte opp.`,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            button(3, "✅ Bekreft at gjesten møtte opp", `guest_ok:${id}`),
            button(4, "❌ Avslå", `guest_no:${id}`),
          ],
        },
      ],
    });
  } catch (err) {
    console.error("Kunne ikke poste ny-gjest", err);
    await db
      .send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { PK: `GUEST#${id}`, SK: "META" },
        }),
      )
      .catch(() => {});
    await db
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `USER#${userId}`, SK: `GUESTREQ#${week}` },
          UpdateExpression: "ADD #n :m",
          ExpressionAttributeNames: { "#n": "count" },
          ExpressionAttributeValues: { ":m": -1 },
        }),
      )
      .catch(() => {});
    return ephemeral(
      "Jeg klarte ikke å sende meldingen akkurat nå. Prøv igjen om litt 🙏",
    );
  }
  return ephemeral(
    "🎮 Takk! En admin eller leder bekrefter at gjesten var her, og så får du poengene.",
  );
}

async function guestConfirm(i, guestId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const guest = await getItem({ PK: `GUEST#${guestId}`, SK: "META" });
  if (!guest) return ephemeral("Fant ikke meldingen.");
  const reviewer = userOf(i).id;
  if (guest.userId === reviewer && !isAdmin(i))
    return ephemeral("Du kan ikke bekrefte din egen gjest 🙂");
  const settings = await loadSettings();
  const award = await computeAward(guest.userId, settings.guestPoints, {
    attendance: false,
  });
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `GUEST#${guestId}`, SK: "META" },
        UpdateExpression:
          "SET #st = :c, reviewedBy = :by, reviewedAt = :ts REMOVE #nt",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status", "#nt": "note" },
        ExpressionAttributeValues: {
          ":c": "confirmed",
          ":p": "pending",
          ":by": reviewer,
          ":ts": now(),
        },
      },
    },
    ...pointsOps({
      userId: guest.userId,
      delta: award.delta,
      basePoints: award.basePoints,
      multiplier: award.multiplier,
      reason: "Tok med ny besøkende",
      givenBy: reviewer,
    }),
  ]);
  if (!r.ok) return ephemeral("Dette er allerede behandlet.");
  await Promise.all([
    withTimeout(
      tryDM(guest.userId, {
        content: `🎮 Gjesten din er bekreftet! Du fikk ${award.delta} poeng${awardNote(award)}. Takk for at du tar med nye folk 💙`,
      }),
      1800,
    ),
    withTimeout(syncLevel(guest.userId), 1800),
  ]);
  return updateMessage({
    content: `✅ Bekreftet av <@${reviewer}> · <@${guest.userId}> fikk ${award.delta} poeng`,
    components: [],
  });
}

async function guestReject(i, guestId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const guest = await getItem({ PK: `GUEST#${guestId}`, SK: "META" });
  if (!guest) return ephemeral("Fant ikke meldingen.");
  const reviewer = userOf(i).id;
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `GUEST#${guestId}`, SK: "META" },
        UpdateExpression:
          "SET #st = :r, reviewedBy = :by, reviewedAt = :ts REMOVE #nt",
        ConditionExpression: "#st = :p",
        ExpressionAttributeNames: { "#st": "status", "#nt": "note" },
        ExpressionAttributeValues: {
          ":r": "rejected",
          ":p": "pending",
          ":by": reviewer,
          ":ts": now(),
        },
      },
    },
  ]);
  if (!r.ok) return ephemeral("Dette er allerede behandlet.");
  await withTimeout(
    tryDM(guest.userId, {
      content:
        "Vi fikk ikke bekreftet gjesten denne gangen. Si fra til en leder hvis du mener det er en feil 🙂",
    }),
    1800,
  );
  return updateMessage({
    content: `❌ Avslått av <@${reviewer}>`,
    components: [],
  });
}

/* ============================================================
 * Fase 3: /leaderboard og månedens frivillige
 * ============================================================ */

async function cmdLeaderboard() {
  const settings = await loadSettings();
  if (!settings.leaderboardEnabled)
    return ephemeral("Topplisten er ikke slått på akkurat nå 🙂");
  const key = todayOslo().slice(0, 7);
  const rows = (
    await queryAll({
      KeyConditionExpression: "PK = :p",
      ExpressionAttributeValues: { ":p": `MONTH#${key}` },
    })
  )
    .filter((r) => (r.earned ?? 0) > 0)
    .sort((a, b) => b.earned - a.earned)
    .slice(0, 5);
  const [, m] = key.split("-");
  if (!rows.length)
    return ephemeral(
      `Ingen poeng er delt ut i ${MONTHS[Number(m) - 1]} ennå. Det er god plass! 🙂`,
    );
  return message({
    embeds: [
      {
        title: `Aktive i ${MONTHS[Number(m) - 1]}`,
        description: rows
          .map((r) => `🌟 <@${r.userId}> · ${r.earned} poeng`)
          .join("\n"),
        color: 0x5865f2,
        footer: { text: "Alle bidrag teller, store som små 💙" },
      },
    ],
  });
}

async function runMonthly() {
  const today = todayOslo();
  const [y, m] = today.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const key = `${py}-${pad(pm)}`;

  const settings = await loadSettings();
  const channel =
    settings.shoutoutChannelId ||
    settings.summaryChannelId ||
    settings.adminChannelId;
  if (!channel) return { skipped: "ingen kanal satt" };
  if (!(await claimJob("monthly", key))) return { skipped: "kjørte allerede" };

  try {
    const rows = (
      await queryAll({
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": `MONTH#${key}` },
      })
    ).filter((r) => (r.earned ?? 0) > 0);
    if (!rows.length) return { winners: 0 };

    const max = Math.max(...rows.map((r) => r.earned));
    const winners = rows.filter((r) => r.earned === max).slice(0, 3);
    const names = winners.map((w) => `<@${w.userId}>`).join(" og ");
    await postToChannel(channel, {
      embeds: [
        {
          title: `🏆 Månedens frivillige: ${MONTHS[pm - 1]}`,
          description:
            `Denne måneden bidro ${names} ekstra mye, med ${max} poeng. Tusen takk for innsatsen! 💙\n\n` +
            `Og takk til dere andre også. Hver minste ting teller.`,
          color: 0xfee75c,
        },
      ],
      allowed_mentions: { parse: [] },
    });
    return { winners: winners.length };
  } catch (err) {
    await releaseJob("monthly");
    throw err;
  }
}

/* ============================================================
 * Fase 4: /oppgave-rediger
 * ============================================================ */

async function cmdOppgaveRediger(i, opts, userId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const task = opts.oppgave ? await getTask(opts.oppgave) : null;
  if (!task || task.status !== "open")
    return ephemeral(
      "Velg en åpen oppgave fra listen som dukker opp når du skriver `/oppgave-rediger`.",
    );

  const names = { "#st": "status" };
  const values = { ":open": "open" };
  const sets = [];
  const removes = [];
  const labels = [];
  let condition = "#st = :open";
  const setField = (field, value) => {
    const n = sets.length;
    names[`#f${n}`] = field;
    values[`:v${n}`] = value;
    sets.push(`#f${n} = :v${n}`);
  };

  const newTitle = opts.tittel ?? task.title;
  const notifyParts = [];
  let slotsIncreased = false;

  if (opts.tittel !== undefined && opts.tittel !== task.title) {
    setField("title", opts.tittel);
    labels.push("tittel");
    notifyParts.push(`tittelen er endret (nå «${newTitle}»)`);
  }
  if (opts.beskrivelse !== undefined && opts.beskrivelse !== task.description) {
    setField("description", opts.beskrivelse);
    labels.push("beskrivelse");
    notifyParts.push("beskrivelsen er endret");
  }
  const size = opts["størrelse"];
  if (size !== undefined && size !== task.size) {
    setField("size", size);
    labels.push(`størrelse → ${SIZES[size]}`);
  }
  if (opts.poeng !== undefined && opts.poeng !== task.points) {
    setField("points", opts.poeng);
    labels.push(`poeng → ${opts.poeng}`);
  }
  if (opts.plasser !== undefined && opts.plasser !== task.slots) {
    if (opts.plasser < task.filledSlots)
      return ephemeral(
        `${task.filledSlots} plass${task.filledSlots === 1 ? " er" : "er er"} allerede tatt eller fullført, så antall plasser kan ikke settes lavere enn det.`,
      );
    setField("slots", opts.plasser);
    labels.push(`plasser → ${opts.plasser}`);
    names["#fs"] = "filledSlots";
    values[":ns"] = opts.plasser; // sikrer at ingen tok en plass mens vi redigerte
    condition += " AND #fs <= :ns";
    slotsIncreased = opts.plasser > task.slots;
  }
  if (opts.frist !== undefined) {
    const raw = opts.frist.trim().toLowerCase();
    if (["ingen", "-", "fjern"].includes(raw)) {
      if (task.deadline) {
        names["#dl"] = "deadline";
        removes.push("#dl");
        setField("GSI1SK", task.createdAt);
        labels.push("frist fjernet");
        notifyParts.push("fristen er fjernet");
      }
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw)))
        return ephemeral(
          "Bruk datoformatet ÅÅÅÅ-MM-DD (f.eks. 2026-11-20), eller skriv `ingen` for å fjerne fristen.",
        );
      if (raw < todayOslo())
        return ephemeral("Fristen kan ikke være i fortiden.");
      if (raw !== task.deadline) {
        setField("deadline", raw);
        setField("GSI1SK", `${raw}T23:59:59`);
        labels.push(`frist → ${fmtDate(raw)}`);
        notifyParts.push(`ny frist ${fmtDate(raw)}`);
      }
    }
  }
  if (!labels.length)
    return ephemeral(
      "Ingen endringer å lagre. Fyll inn minst ett felt du vil endre.",
    );

  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: taskKey(task.id),
        UpdateExpression:
          `SET ${sets.join(", ")}` +
          (removes.length ? ` REMOVE ${removes.join(", ")}` : ""),
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return ephemeral(
        "Oppgaven endret seg mens du redigerte (eller ble lukket). Prøv igjen.",
      );
    throw err;
  }

  // Beskjed til påmeldte og opprykk fra venteliste skjer i bakgrunnen (kan ta tid)
  const notify = notifyParts.length
    ? `✏️ Oppgaven du er påmeldt på er endret: ${notifyParts.join(", ")}. Se detaljer med \`/oppgaver\` eller \`/mine-oppgaver\`.`
    : null;
  let warning = "";
  if (notify || slotsIncreased) {
    const started = await dispatchAsync({
      job: "taskEdited",
      taskId: task.id,
      promote: slotsIncreased,
      notify,
    });
    if (!started)
      warning =
        "\n⚠️ Påmeldte og venteliste ble ikke oppdatert automatisk (bakgrunnsjobb mangler, se oppsett).";
  }
  const extra = [];
  if (notify) extra.push("påmeldte får beskjed på DM");
  if (slotsIncreased) extra.push("venteliste rykker opp automatisk");
  if (
    opts["størrelse"] !== undefined &&
    opts.poeng === undefined &&
    size !== task.size
  )
    extra.push(
      `poengene er uendret (${task.points}), bruk \`poeng\` for å endre dem`,
    );
  return ephemeral(
    `✅ Oppdaterte **${newTitle}**: ${labels.join(", ")}.` +
      (extra.length ? `\n${extra.join(" · ")}` : "") +
      warning,
  );
}

async function runTaskEdited(p) {
  const task = await getTask(p.taskId);
  if (!task || task.status !== "open")
    return { skipped: "oppgaven er ikke åpen" };
  let promoted = 0;
  let notified = 0;

  if (p.promote) {
    const settings = await loadSettings();
    for (let n = 0; n < 50; n++) {
      const fresh = await getTask(p.taskId);
      if (!fresh || fresh.filledSlots >= fresh.slots) break;
      const cand = await nextWaitlisted(p.taskId, settings);
      if (!cand) break;
      const ts = now();
      const r = await transact([
        signupUpdate(p.taskId, cand.userId, ["waitlist"], "active", {
          signedUpAt: ts,
          GSI1SK: ts,
          GSI2SK: `SIGNUP#${ts}`,
        }),
        {
          Update: {
            TableName: TABLE,
            Key: taskKey(p.taskId),
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
      ]);
      if (r.ok) {
        promoted++;
        await tryDM(cand.userId, {
          content: `🎉 Det ble ledig plass! Du har fått plassen på **${fresh.title}**. Bruk \`/mine-oppgaver\` for å se den, og \`/ferdig\` når du er ferdig.`,
        });
      } else if (failedAt(r, 1)) {
        break; // oppgaven ble full
      }
    }
  }

  if (p.notify) {
    const signups = await queryAll({
      KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
      FilterExpression: "#st IN (:a, :w)",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":p": `TASK#${p.taskId}`,
        ":s": "SIGNUP#",
        ":a": "active",
        ":w": "waitlist",
      },
    });
    for (const s of signups.slice(0, 50)) {
      if (await tryDM(s.userId, { content: p.notify })) notified++;
    }
  }
  return { promoted, notified };
}

/* ============================================================
 * Fase 4: /eksport (CSV)
 * ============================================================ */

const EXPORT_LABELS = {
  alt: "Alt",
  frivillige: "Frivillige",
  oppgaver: "Oppgaver",
  poenglogg: "Poenglogg",
  moter: "Møter",
};

// Én gjenbrukt formatter: å opprette en ny per rad er ca. 30 ganger tregere (merkbart ved store eksporter)
const OSLO_STAMP = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const osloStamp = (iso) => (iso ? OSLO_STAMP.format(new Date(iso)) : "");

// Norsk Excel: semikolon som skilletegn, komma som desimaltegn, UTF-8 med BOM.
// Tekst som starter med = + - @ prefikses, så regneark ikke tolker den som formel.
function csvCell(v, forceText = false) {
  if (v === null || v === undefined) return "";
  // IDer som ligner tall (f.eks. 12e45678 eller 18-sifrede Discord-IDer) tvinges til tekst, så Excel/Sheets ikke runder av
  if (forceText && typeof v === "string" && /^[\d.]+(e[+-]?\d+)?$/i.test(v))
    return `="${v}"`;
  if (typeof v === "boolean") return v ? "ja" : "nei";
  if (typeof v === "number") return String(v).replace(".", ",");
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, rows, idCols = []) {
  const ids = new Set(idCols);
  const lines = [
    header.map((h) => csvCell(h)),
    ...rows.map((r) => r.map((v, c) => csvCell(v, ids.has(c)))),
  ];
  return "\uFEFF" + lines.map((l) => l.join(";")).join("\r\n") + "\r\n";
}

/* ---------- XLSX uten avhengigheter (zip + Office Open XML) ---------- */

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET_NAMES = {
  frivillige: "Frivillige",
  oppgaver: "Oppgaver",
  poenglogg: "Poenglogg",
  moter: "Møter",
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n++)
    c = CRC_TABLE[(c ^ buf[n]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal zip-skriver (deflate). Nok for en xlsx-fil.
function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // versjon som trengs
    lh.writeUInt16LE(0x0800, 6); // UTF-8-filnavn
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Fjerner tegn som ikke er lov i XML (ellers blir filen «ødelagt» i Excel)
const xmlEscape = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function colLetter(n) {
  let s = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26))
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

// «2026-11-02 10:00:00» eller «2026-11-02» → Excel-dato (serienummer, uten tidssone)
function excelSerial(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(
    String(str),
  );
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, se = 0] = m
    .slice(1)
    .map((x) => (x === undefined ? undefined : Number(x)));
  return Date.UTC(y, mo - 1, d, h, mi, se) / 86400000 + 25569;
}

function sheetXml(header, rows, { idCols = [], dateCols = [] } = {}) {
  const idSet = new Set(idCols);
  const dateSet = new Set(dateCols);
  const widths = header.map((h) => Math.min(60, String(h).length + 4));
  const out = [
    `<row r="1">${header
      .map(
        (h, c) =>
          `<c r="${colLetter(c)}1" s="1" t="inlineStr"><is><t>${xmlEscape(h)}</t></is></c>`,
      )
      .join("")}</row>`,
  ];
  rows.forEach((row, r) => {
    const cells = [];
    row.forEach((v, c) => {
      if (v === null || v === undefined || v === "") return;
      const ref = `${colLetter(c)}${r + 2}`;
      if (r < 300)
        widths[c] = Math.max(widths[c], Math.min(60, String(v).length + 2));
      if (!idSet.has(c) && typeof v === "number" && Number.isFinite(v)) {
        cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else if (!idSet.has(c) && typeof v === "boolean") {
        cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else if (dateSet.has(c) && excelSerial(v) !== null) {
        cells.push(
          `<c r="${ref}" s="${String(v).length === 10 ? 3 : 2}"><v>${excelSerial(v)}</v></c>`,
        );
      } else {
        // IDer og all annen tekst lagres som tekst, så Excel aldri runder av eller tolker dem
        cells.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`,
        );
      }
    });
    out.push(`<row r="${r + 2}">${cells.join("")}</row>`);
  });
  const cols = widths
    .map(
      (w, c) =>
        `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${out.join("")}</sheetData>` +
    `<autoFilter ref="A1:${colLetter(header.length - 1)}${rows.length + 1}"/></worksheet>`
  );
}

const XLSX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// sheets: [{ name, header, rows, idCols, dateCols }]
function buildXlsx(sheets) {
  const n = sheets.length;
  const files = [
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets
          .map(
            (_, k) =>
              `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets
          .map(
            (s, k) =>
              `<sheet name="${xmlEscape(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`,
          )
          .join("") +
        `</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, k) =>
              `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: XLSX_STYLES },
    ...sheets.map((s, k) => ({
      name: `xl/worksheets/sheet${k + 1}.xml`,
      data: sheetXml(s.header, s.rows, s),
    })),
  ];
  return zipFiles(files);
}

async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(
      new ScanCommand({ TableName: TABLE, ...params, ExclusiveStartKey }),
    );
    for (const item of r.Items ?? []) items.push(item);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Henter alle elementer av én type, evt. avgrenset på et tidsfelt (ISO-strenger)
function scanEntity(entity, { field, fromIso, toIso } = {}) {
  const names = {};
  const values = { ":e": entity };
  let filter = "entity = :e";
  if (field && fromIso) {
    names["#t"] = field;
    values[":f"] = fromIso;
    filter += " AND #t >= :f";
  }
  if (field && toIso) {
    names["#t"] = field;
    values[":t"] = toIso;
    filter += " AND #t < :t";
  }
  return scanAll({
    FilterExpression: filter,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  });
}

async function buildExport(type, { fraIso, toIso }) {
  const range = { fromIso: fraIso, toIso };
  if (type === "frivillige") {
    const [profiles, approved] = await Promise.all([
      scanAll({
        FilterExpression: "SK = :s",
        ExpressionAttributeValues: { ":s": "PROFILE" },
      }),
      scanAll({
        FilterExpression: "entity = :e AND #st = :a",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":e": "COMPLETION", ":a": "approved" },
      }),
    ]);
    const done = new Map();
    for (const c of approved) done.set(c.userId, (done.get(c.userId) ?? 0) + 1);
    const rows = profiles
      .map((p) => ({ ...p, userId: p.PK.replace("USER#", "") }))
      .sort((a, b) => (b.totalEarned ?? 0) - (a.totalEarned ?? 0))
      .map((p) => [
        p.userId,
        p.points ?? 0,
        p.totalEarned ?? 0,
        LEVELS.find((l) => l.key === p.level)?.name ?? "",
        p.attendanceStreak ?? 0,
        p.lastStreakWeek ?? "",
        done.get(p.userId) ?? 0,
        osloStamp(p.createdAt),
      ]);
    return {
      header: [
        "discord_id",
        "poeng",
        "totalt_opptjent",
        "nivå",
        "streak_uker",
        "siste_streak_uke",
        "fullførte_oppgaver",
        "opprettet",
      ],
      rows,
      userCol: 0,
      idCols: [0],
      dateCols: [7],
    };
  }

  if (type === "oppgaver") {
    const tasks = (
      await scanEntity("TASK", { field: "createdAt", ...range })
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      header: [
        "id",
        "tittel",
        "størrelse",
        "poeng",
        "plasser",
        "tatt",
        "fullført",
        "status",
        "frist",
        "opprettet",
        "mal_id",
        "opprettet_av",
      ],
      rows: tasks.map((t) => [
        t.id,
        t.title,
        SIZES[t.size] ?? t.size,
        t.points,
        t.slots,
        t.filledSlots,
        t.doneCount ?? 0,
        t.status,
        t.deadline ?? "",
        osloStamp(t.createdAt),
        t.templateId ?? "",
        t.createdBy ?? "",
      ]),
      userCol: null,
      idCols: [0, 10, 11],
      dateCols: [8, 9],
    };
  }

  if (type === "poenglogg") {
    const logs = (
      await scanEntity("LOG", { field: "createdAt", ...range })
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      header: [
        "tidspunkt",
        "discord_id",
        "poeng",
        "grunnlag",
        "multiplikator",
        "begrunnelse",
        "gitt_av",
        "oppgave_id",
      ],
      rows: logs.map((l) => [
        osloStamp(l.createdAt),
        l.PK.replace("USER#", ""),
        l.delta,
        l.basePoints ?? l.delta,
        l.multiplier ?? 1,
        l.reason ?? "",
        l.givenBy ?? "",
        l.taskId ?? "",
      ]),
      userCol: 1,
      idCols: [1, 6, 7],
      dateCols: [0],
    };
  }

  // møter
  const meetings = (
    await scanEntity("MEETING", { field: "startsAt", ...range })
  ).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    header: ["id", "tittel", "start", "plasser", "påmeldte", "møtte_opp"],
    rows: meetings.map((m) => [
      m.id,
      m.title,
      osloStamp(m.startsAt),
      m.slots,
      m.filledSlots,
      m.attendedCount ?? 0,
    ]),
    userCol: null,
    idCols: [0],
    dateCols: [2],
  };
}

// Navn: først servernavn (kallenavn), ellers globalt visningsnavn/brukernavn.
// Faller tilbake til /users/{id}, som virker uten GUILD_ID og uten at personen er på serveren.
async function lookupNames(userIds, cache = new Map(), problems = {}) {
  const guild = process.env.GUILD_ID;
  if (!guild) problems.noGuild = true;
  const missing = [...new Set(userIds)]
    .filter((id) => !cache.has(id))
    .slice(0, 500);
  for (const part of chunk(missing, 5)) {
    await Promise.all(
      part.map(async (id) => {
        let name = null;
        let left = false;
        if (guild) {
          try {
            const m = await discord(`/guilds/${guild}/members/${id}`);
            name = m.nick ?? m.user?.global_name ?? m.user?.username ?? null;
          } catch (err) {
            if (err.status === 404) left = true;
            else {
              problems.guildError ??= `Discord svarte ${err.status ?? "feil"}`;
              console.warn("Servernavn feilet for", id, err.message);
            }
          }
        }
        if (!name) {
          try {
            const u = await discord(`/users/${id}`);
            name =
              (u.global_name ?? u.username ?? "") +
              (left && (u.global_name ?? u.username)
                ? " (forlatt serveren)"
                : "");
          } catch (err) {
            problems.userError ??= `Discord svarte ${err.status ?? "feil"}`;
            console.warn("Brukernavn feilet for", id, err.message);
            name = left ? "(forlatt serveren)" : "";
          }
        }
        cache.set(id, name ?? "");
      }),
    );
  }
  return cache;
}

const EXPORT_MAX_BYTES = 9.5 * 1024 * 1024; // Discord tar imot ca. 10 MB per melding uten serverboost
const EXPORT_ALL = ["frivillige", "oppgaver", "poenglogg", "moter"];

// Sender én melding med null eller flere filer på DM.
// Er DM stengt, havner den i admin-kanalen.
async function deliverToRequester(p, content, files = []) {
  const makeForm = (text) => {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: text,
        ...(files.length
          ? { attachments: files.map((f, n) => ({ id: n, filename: f.name })) }
          : {}),
        allowed_mentions: { users: [p.requesterId] },
      }),
    );
    files.forEach((f, n) =>
      form.append(`files[${n}]`, new Blob([f.data], { type: f.mime }), f.name),
    );
    return form;
  };
  try {
    const ch = await discord("/users/@me/channels", {
      method: "POST",
      body: { recipient_id: p.requesterId },
    });
    await discord(`/channels/${ch.id}/messages`, {
      method: "POST",
      form: makeForm(content),
      timeout: 30000,
    });
    return "dm";
  } catch (err) {
    console.warn("Kunne ikke sende eksport på DM:", err.message);
    if (!p.adminChannelId) throw err;
    await discord(`/channels/${p.adminChannelId}/messages`, {
      method: "POST",
      form: makeForm(
        `<@${p.requesterId}> DM var stengt, så eksporten ligger her:\n${content}`,
      ),
      timeout: 30000,
    });
    return "kanal";
  }
}

async function runExport(p) {
  try {
    const fraIso = p.fra ? osloLocalToIso(p.fra, "00:00") : undefined;
    const toIso = p.til
      ? osloLocalToIso(addDays(p.til, 1), "00:00")
      : undefined; // «til» er inklusiv
    const types = p.type === "alt" ? EXPORT_ALL : [p.type];
    const format = p.format === "csv" ? "csv" : "xlsx";
    const nameCache = new Map();
    const nameProblems = {};
    const datasets = [];
    const lines = [];

    for (const type of types) {
      let { header, rows, userCol, idCols, dateCols } = await buildExport(
        type,
        { fraIso, toIso },
      );
      if (p.names && userCol !== null && rows.length) {
        await lookupNames(
          rows.map((r) => r[userCol]),
          nameCache,
          nameProblems,
        );
        const shift = (cols) => cols.map((c) => (c > userCol ? c + 1 : c));
        header = [
          ...header.slice(0, userCol + 1),
          "brukernavn",
          ...header.slice(userCol + 1),
        ];
        rows = rows.map((r) => [
          ...r.slice(0, userCol + 1),
          nameCache.get(r[userCol]) ?? "",
          ...r.slice(userCol + 1),
        ]);
        idCols = shift(idCols);
        dateCols = shift(dateCols);
      }
      datasets.push({
        type,
        name: SHEET_NAMES[type],
        header,
        rows,
        idCols,
        dateCols,
      });
      lines.push(
        `• ${EXPORT_LABELS[type]}: ${rows.length ? `${rows.length} rader` : "ingen rader"}`,
      );
    }

    if (p.names && nameCache.size) {
      const unresolved = [...nameCache.values()].filter((v) => !v).length;
      if (unresolved)
        lines.push(
          `⚠️ Brukernavn: fikk ikke hentet ${unresolved} av ${nameCache.size}` +
            (nameProblems.userError || nameProblems.guildError
              ? ` (${nameProblems.userError ?? nameProblems.guildError})`
              : "") +
            ". Sjekk at `DISCORD_TOKEN` er riktig, og se CloudWatch-loggen.",
        );
      if (nameProblems.noGuild)
        lines.push(
          "ℹ️ `GUILD_ID` mangler på Lambdaen, så navnene er globale brukernavn og ikke kallenavn på serveren.",
        );
      else if (nameProblems.guildError && !unresolved)
        lines.push(
          `ℹ️ Fikk ikke hentet kallenavn på serveren (${nameProblems.guildError}), så navnene er globale brukernavn.`,
        );
    }

    const files = [];
    if (datasets.some((d) => d.rows.length)) {
      if (format === "xlsx") {
        // Én arbeidsbok med én fane per type (tomme typer får en fane med bare overskrifter)
        const data = buildXlsx(datasets);
        if (data.length > EXPORT_MAX_BYTES)
          lines.push(
            "⚠️ Excel-filen ble for stor for Discord. Avgrens perioden med `fra` og `til`, eller bruk `format:csv`.",
          );
        else
          files.push({
            name: `eksport-${p.type}-${todayOslo()}.xlsx`,
            data,
            mime: XLSX_MIME,
          });
      } else {
        for (const d of datasets.filter((x) => x.rows.length)) {
          const data = Buffer.from(toCsv(d.header, d.rows, d.idCols), "utf8");
          if (data.length > EXPORT_MAX_BYTES) {
            lines.push(
              `⚠️ ${EXPORT_LABELS[d.type]}: filen er for stor for Discord. Avgrens perioden med \`fra\` og \`til\``,
            );
            continue;
          }
          files.push({
            name: `eksport-${d.type}-${todayOslo()}.csv`,
            data,
            mime: "text/csv; charset=utf-8",
          });
        }
      }
    }

    const period =
      p.fra || p.til ? ` (${p.fra ?? "start"} til ${p.til ?? "nå"})` : "";
    const footer =
      format === "xlsx"
        ? "Excel-fil med én fane per type. Åpnes direkte i Excel og Google Sheets. Inneholder personopplysninger, så ikke del den videre."
        : "Semikolon-separert UTF-8, åpnes direkte i Excel. Inneholder personopplysninger, så ikke del dem videre.";
    const content =
      `📤 **Eksport: ${EXPORT_LABELS[p.type]}**${period}\n${lines.join("\n")}` +
      (files.length ? `\n${footer}` : "");

    // Alle filene i én melding hvis de får plass, ellers én melding per fil
    const total = files.reduce((n, f) => n + f.data.length, 0);
    const groups =
      files.length && total > EXPORT_MAX_BYTES
        ? files.map((f) => [f])
        : [files];
    let where;
    for (const [n, group] of groups.entries()) {
      where = await deliverToRequester(
        p,
        n === 0 ? content : `📎 ${group.map((f) => f.name).join(", ")}`,
        group,
      );
    }
    return { files: files.length, where, format };
  } catch (err) {
    console.error("Eksport feilet:", err);
    const hint = /AccessDenied|not authorized/i.test(String(err.message))
      ? " Lambdaen mangler trolig tillatelsen `dynamodb:Scan` (se SETUP.md)."
      : "";
    await deliverToRequester(
      p,
      `⚠️ Eksporten feilet: ${String(err.message).slice(0, 200)}.${hint}`,
    ).catch(() => {});
    return { error: String(err.message) };
  }
}

async function cmdEksport(i, opts, userId) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  for (const key of ["fra", "til"]) {
    if (
      opts[key] &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(opts[key]) ||
        Number.isNaN(Date.parse(opts[key])))
    )
      return ephemeral(
        `\`${key}\` må skrives som ÅÅÅÅ-MM-DD, f.eks. 2026-11-01.`,
      );
  }
  if (opts.fra && opts.til && opts.fra > opts.til)
    return ephemeral("`fra` kan ikke være etter `til`.");

  const settings = await loadSettings();
  const started = await dispatchAsync({
    job: "export",
    type: opts.type,
    fra: opts.fra,
    til: opts.til,
    names: Boolean(opts.brukernavn),
    format: opts.format ?? "xlsx",
    requesterId: userId,
    adminChannelId: settings.adminChannelId,
  });
  if (!started)
    return ephemeral(
      "Jeg klarte ikke å starte eksporten. Sjekk at Lambdaen har tillatelsen `lambda:InvokeFunction` (se SETUP.md).",
    );
  const note =
    (opts.type === "frivillige" || opts.type === "alt") &&
    (opts.fra || opts.til)
      ? "\n_Merk: perioden brukes ikke for «Frivillige»._"
      : "";
  return ephemeral(
    `📤 Eksporten **${EXPORT_LABELS[opts.type]}** lages nå. ${(opts.format ?? "xlsx") === "xlsx" ? "Excel-filen kommer" : opts.type === "alt" ? "Filene kommer" : "Filen kommer"} på DM til deg om litt (eller i admin-kanalen hvis DM er stengt).${note}`,
  );
}

/* ============================================================
 * Fase 5: «Bli frivillig»-knapp og rollekrav for poeng
 * ============================================================ */

// Er rollekrav slått på (volunteerRoleId satt), må man ha rollen for å samle poeng
const isVolunteer = (i, settings) =>
  !settings.volunteerRoleId ||
  memberRoles(i).includes(settings.volunteerRoleId);

function notVolunteerReply(settings) {
  const where = settings.volunteerChannelId
    ? ` i <#${settings.volunteerChannelId}>`
    : "";
  return ephemeral(
    `🙋 For å samle poeng må du først bli frivillig. Trykk på «Bli frivillig»-knappen${where}, så får du rollen med en gang.`,
  );
}

function roleErrorHint(err) {
  if (err.status === 403)
    return "boten mangler tillatelsen *Manage Roles*, eller Frivillig-rollen ligger over botens rolle i rollelisten (Serverinnstillinger → Roller).";
  if (err.status === 404)
    return "rollen eller brukeren finnes ikke. Sjekk rolle-ID-en i `/innstillinger`.";
  return `Discord svarte ${err.status ?? "med en feil"}.`;
}

async function cmdFrivilligKnapp(i, opts, userId) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const settings = await loadSettings();
  if (!settings.volunteerRoleId)
    return ephemeral(
      "Sett først rollen: `/innstillinger innstilling:Discord-rolle: Frivillig verdi:<rolle-ID>`. Lag rollen i Serverinnstillinger → Roller hvis du ikke har den.",
    );

  const text =
    opts.tekst ??
    `Vil du hjelpe til og samle poeng? Trykk på knappen under for å få rollen <@&${settings.volunteerRoleId}>.\n\n` +
      "Da kan du ta oppgaver med `/oppgaver`, delta på møter og få poeng.\n" +
      "Du kan når som helst gå ut igjen, og poengene dine blir liggende.";
  try {
    await postToChannel(i.channel_id, {
      embeds: [
        { title: "🙋 Bli frivillig", description: text, color: 0x57f287 },
      ],
      components: [
        {
          type: 1,
          components: [
            button(3, "🙋 Bli frivillig", "join_vol"),
            button(2, "Slutt som frivillig", "leave_vol"),
          ],
        },
      ],
      allowed_mentions: { parse: [] },
    });
  } catch (err) {
    console.error("Kunne ikke poste frivillig-knapp", err.message);
    return ephemeral(
      "Jeg fikk ikke postet i denne kanalen. Gi meg tillatelsene *Se kanal*, *Send meldinger* og *Bygg inn lenker* her.",
    );
  }
  // Husk kanalen, så beskjeden til de som mangler rollen kan peke hit
  await db
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: "CONFIG", SK: "SETTINGS" },
        UpdateExpression: "SET volunteerChannelId = :c, updatedAt = :ts",
        ExpressionAttributeValues: { ":c": i.channel_id, ":ts": now() },
      }),
    )
    .catch((e) =>
      console.warn("Kunne ikke lagre volunteerChannelId", e.message),
    );
  return ephemeral(
    "✅ Knappen er lagt ut i kanalen. Fest meldingen (høyreklikk → Fest melding) så den blir stående.",
  );
}

async function joinVolunteer(i) {
  const settings = await loadSettings();
  const roleId = settings.volunteerRoleId;
  if (!roleId)
    return ephemeral(
      "Frivillig-rollen er ikke satt opp ennå. Si fra til en admin 🙂",
    );
  const user = userOf(i);
  if (memberRoles(i).includes(roleId))
    return ephemeral(
      "Du er allerede frivillig 🎉 Se hva som er ledig med `/oppgaver`.",
    );

  const guild = i.guild_id ?? process.env.GUILD_ID;
  try {
    await discord(`/guilds/${guild}/members/${user.id}/roles/${roleId}`, {
      method: "PUT",
    });
  } catch (err) {
    console.error("Kunne ikke gi frivillig-rolle:", err.message);
    if (settings.adminChannelId)
      await withTimeout(
        postToChannel(settings.adminChannelId, {
          content: `⚠️ Jeg kunne ikke gi Frivillig-rollen til <@${user.id}>: ${roleErrorHint(err)}`,
          allowed_mentions: { parse: [] },
        }),
        1500,
      );
    return ephemeral(
      "Beklager, jeg klarte ikke å gi deg rollen akkurat nå. Jeg har gitt admin beskjed 🙏",
    );
  }
  return ephemeral(
    "🙌 Velkommen som frivillig! Rollen er din. Slik kommer du i gang:\n" +
      "• `/oppgaver` – se og ta oppgaver\n" +
      "• `/mine-oppgaver` – dine oppgaver\n" +
      "• `/poeng` – se poengene dine\n" +
      "Husk å ha DM åpne fra serveren, så får du beskjeder fra meg 💙",
  );
}

async function leaveVolunteer(i) {
  const settings = await loadSettings();
  const roleId = settings.volunteerRoleId;
  if (!roleId) return ephemeral("Frivillig-rollen er ikke satt opp.");
  const user = userOf(i);
  if (!memberRoles(i).includes(roleId))
    return ephemeral("Du er ikke frivillig akkurat nå 🙂");

  const open = await userSignups(user.id, ["active", "waitlist", "submitted"]);
  if (open.length)
    return ephemeral(
      `Du har ${open.length} oppgave${open.length === 1 ? "" : "r"} (eller ventelisteplass) som ikke er avsluttet. Slipp eller ferdigmeld dem først med \`/mine-oppgaver\`, så kan du melde deg ut.`,
    );
  const guild = i.guild_id ?? process.env.GUILD_ID;
  try {
    await discord(`/guilds/${guild}/members/${user.id}/roles/${roleId}`, {
      method: "DELETE",
    });
  } catch (err) {
    console.error("Kunne ikke fjerne frivillig-rolle:", err.message);
    return ephemeral(
      "Beklager, jeg klarte ikke å ta bort rollen akkurat nå. Prøv igjen, eller si fra til en admin 🙏",
    );
  }
  return ephemeral(
    "👋 Du er ikke lenger frivillig. Poengene dine ligger trygt, og du kan trykke på «Bli frivillig» igjen når som helst. Takk for innsatsen! 💙",
  );
}

// Gir rollen til alle som allerede har en poengprofil, så ingen faller utenfor når rollekravet slås på
async function cmdFrivilligSynk(i, opts, userId) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  const settings = await loadSettings();
  if (!settings.volunteerRoleId)
    return ephemeral(
      "Sett først rollen med `/innstillinger` (Discord-rolle: Frivillig).",
    );
  const started = await dispatchAsync({
    job: "grantRole",
    requesterId: userId,
    guildId: i.guild_id ?? process.env.GUILD_ID,
    roleId: settings.volunteerRoleId,
    adminChannelId: settings.adminChannelId,
  });
  if (!started)
    return ephemeral(
      "Jeg klarte ikke å starte jobben. Sjekk at Lambdaen har tillatelsen `lambda:InvokeFunction` (se SETUP.md).",
    );
  return ephemeral(
    "⏳ Gir rollen til alle som allerede har poeng. Du får en DM med resultatet når jeg er ferdig.",
  );
}

async function runGrantRole(p) {
  try {
    const profiles = await scanAll({
      FilterExpression: "SK = :s",
      ExpressionAttributeValues: { ":s": "PROFILE" },
    });
    const ids = profiles.map((x) => x.PK.replace("USER#", ""));
    let given = 0;
    let left = 0;
    let failed = 0;
    let firstError;
    for (const part of chunk(ids, 5)) {
      await Promise.all(
        part.map(async (id) => {
          try {
            await discord(
              `/guilds/${p.guildId}/members/${id}/roles/${p.roleId}`,
              { method: "PUT" },
            );
            given++;
          } catch (err) {
            if (err.status === 404) left++;
            else {
              failed++;
              firstError ??= err;
            }
          }
        }),
      );
    }
    const parts = [
      `✅ Frivillig-rollen er gitt til **${given}** av ${ids.length} med poengprofil.`,
    ];
    if (left) parts.push(`${left} er ikke lenger på serveren.`);
    if (failed) parts.push(`⚠️ ${failed} feilet: ${roleErrorHint(firstError)}`);
    await deliverToRequester(p, parts.join("\n"));
    return { given, left, failed };
  } catch (err) {
    console.error("grantRole feilet:", err);
    await deliverToRequester(
      p,
      `⚠️ Jobben feilet: ${String(err.message).slice(0, 200)}`,
    ).catch(() => {});
    return { error: String(err.message) };
  }
}

/* ============================================================
 * Fase 6: møtemaler (gjentakende møter som legges ut automatisk)
 * ============================================================ */

const meetingTemplateKey = (id) => ({
  PK: `MEETINGTEMPLATE#${id}`,
  SK: "META",
});
const listMeetingTemplates = () =>
  queryAll({
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "MEETINGTEMPLATES" },
  });

const daysBetween = (a, b) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Første forekomst på eller etter datoen `from` (norsk dato, ÅÅÅÅ-MM-DD)
function nextOccurrence(tpl, from) {
  if (tpl.interval === "weekly")
    return addDays(from, (tpl.anchorDay - isoWeekday(from) + 7) % 7);
  if (tpl.interval === "biweekly") {
    const gap = daysBetween(tpl.startDate, from);
    return gap <= 0
      ? tpl.startDate
      : addDays(tpl.startDate, Math.ceil(gap / 14) * 14);
  }
  const [y, m] = from.split("-").map(Number);
  const thisMonth = `${y}-${pad(m)}-${pad(tpl.anchorDay)}`;
  if (thisMonth >= from) return thisMonth;
  return `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-${pad(tpl.anchorDay)}`;
}

// Neste møte som ikke har startet ennå
function upcomingOccurrence(tpl) {
  const occ = nextOccurrence(tpl, todayOslo());
  return Date.parse(osloLocalToIso(occ, tpl.time)) <= Date.now()
    ? nextOccurrence(tpl, addDays(occ, 1))
    : occ;
}

function describeMeetingSchedule(t) {
  if (t.interval === "weekly")
    return `hver ${WEEKDAYS[t.anchorDay - 1]} kl. ${t.time}`;
  if (t.interval === "biweekly")
    return `annenhver ${WEEKDAYS[t.anchorDay - 1]} kl. ${t.time}`;
  return `den ${t.anchorDay}. hver måned kl. ${t.time}`;
}

function channelErrorHint(err) {
  if (err.status === 403)
    return "boten mangler tilgang i kanalen. Den trenger *Se kanal*, *Send meldinger* og *Bygg inn lenker* der.";
  if (err.status === 404)
    return "kanalen finnes ikke lenger. Slett malen og lag den på nytt.";
  return `Discord svarte ${err.status ?? "med en feil"}.`;
}

// Legger ut neste møte hvis det er innenfor «legg ut så mange dager før». Trygt å kjøre flere ganger.
// Gir null (ikke aktuelt), { meeting } (lagt ut) eller { error } (kunne ikke poste, rullet tilbake).
async function spawnMeetingFromTemplate(tpl) {
  const today = todayOslo();
  const occ = upcomingOccurrence(tpl);
  if (daysBetween(today, occ) > (tpl.leadDays ?? 3)) return null;
  if (tpl.lastOccurrence && tpl.lastOccurrence >= occ) return null;

  const id = randomBytes(4).toString("hex");
  const meeting = {
    ...meetingKey(id),
    entity: "MEETING",
    id,
    title: tpl.title,
    slots: tpl.slots,
    filledSlots: 0,
    attendedCount: 0,
    startsAt: osloLocalToIso(occ, tpl.time),
    createdBy: "system",
    createdAt: now(),
    templateId: tpl.id,
  };
  const r = await transact([
    {
      Update: {
        TableName: TABLE,
        Key: meetingTemplateKey(tpl.id),
        UpdateExpression: "SET lastOccurrence = :o",
        ConditionExpression:
          "attribute_not_exists(lastOccurrence) OR lastOccurrence < :o",
        ExpressionAttributeValues: { ":o": occ },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: meeting,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ]);
  if (!r.ok) return null; // noen andre rakk det først

  try {
    await postToChannel(tpl.channelId, renderMeeting(meeting));
    return { meeting, occ };
  } catch (err) {
    console.error("Kunne ikke poste møte fra mal", tpl.id, err.message);
    await db
      .send(new DeleteCommand({ TableName: TABLE, Key: meetingKey(id) }))
      .catch(() => {});
    await db
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: meetingTemplateKey(tpl.id),
          UpdateExpression: "REMOVE lastOccurrence",
          ConditionExpression: "lastOccurrence = :o",
          ExpressionAttributeValues: { ":o": occ },
        }),
      )
      .catch(() => {});
    return { error: err, occ };
  }
}

async function cmdMoteMalNy(i, opts, userId) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const interval = opts.intervall;
  const dag = opts.dag;
  if (interval !== "monthly" && dag > 7)
    return ephemeral(
      "For ukentlige og annenhver-uke-møter må `dag` være 1–7 (1 = mandag, 7 = søndag).",
    );
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(opts.klokkeslett.trim());
  if (!m)
    return ephemeral("Bruk klokkeslett som TT:MM, f.eks. 18:30 (norsk tid).");
  const time = `${pad(Number(m[1]))}:${m[2]}`;

  let startDate;
  if (interval === "biweekly") {
    const today = todayOslo();
    startDate = addDays(today, (dag - isoWeekday(today) + 7) % 7);
    if (Date.parse(osloLocalToIso(startDate, time)) <= Date.now())
      startDate = addDays(startDate, 7);
  }

  const id = randomBytes(4).toString("hex");
  const tpl = {
    ...meetingTemplateKey(id),
    entity: "MEETINGTEMPLATE",
    id,
    title: opts.tittel,
    time,
    interval,
    anchorDay: dag,
    startDate,
    slots: opts.plasser ?? null, // null = ubegrenset
    leadDays: opts.dagerfor ?? 3,
    channelId: opts.kanal ?? i.channel_id,
    createdBy: userId,
    createdAt: now(),
    GSI1PK: "MEETINGTEMPLATES",
    GSI1SK: id,
  };
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: tpl,
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );

  const spawned = await spawnMeetingFromTemplate(tpl);
  const head = `✅ Møtemal **${tpl.title}** opprettet (${describeMeetingSchedule(tpl)}, i <#${tpl.channelId}>).`;
  if (spawned?.meeting)
    return ephemeral(`${head}\nNeste møte er allerede lagt ut i kanalen.`);
  if (spawned?.error)
    return ephemeral(
      `${head}\n⚠️ Jeg fikk ikke lagt ut neste møte: ${channelErrorHint(spawned.error)} Jeg prøver igjen i natt.`,
    );
  const next = upcomingOccurrence(tpl);
  return ephemeral(
    `${head}\nNeste møte er ${fmtDate(next)}, og det legges ut automatisk ${tpl.leadDays} dager før.`,
  );
}

async function cmdMoteMalListe(i) {
  if (!canManage(i)) return ephemeral(NO_ACCESS);
  const templates = await listMeetingTemplates();
  if (!templates.length)
    return ephemeral("Ingen møtemaler ennå. Lag en med `/møtemal-ny`.");
  const lines = templates.map(
    (t) =>
      `• **${t.title}** · ${describeMeetingSchedule(t)} · <#${t.channelId}> · ${t.slots == null ? "ubegrenset" : `${t.slots} plasser`} · legges ut ${t.leadDays} dager før · neste: ${fmtDate(upcomingOccurrence(t))}`,
  );
  return ephemeral(`**Møtemaler**\n${lines.join("\n")}`.slice(0, 1990));
}

async function cmdMoteMalSlett(i, opts) {
  if (!isAdmin(i)) return ephemeral(NO_ACCESS);
  try {
    await db.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: meetingTemplateKey(opts.mal),
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return ephemeral("Fant ikke den malen. Velg en fra listen.");
    throw err;
  }
  return ephemeral(
    "🗑️ Møtemalen er slettet. Møter som allerede er lagt ut, blir liggende.",
  );
}

/* ============================================================
 * Lambda-handler
 * ============================================================ */

export const handler = async (event) => {
  // Planlagt jobb fra EventBridge (Scheduler: input {"job":"checkin"})
  if (event.job || event.source === "aws.events") {
    return runJob(event.job ?? "checkin", event);
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
