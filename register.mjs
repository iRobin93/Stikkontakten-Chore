const commands = [
  { name: "ping", description: "Replies with pong" },
  {
    name: "hello",
    description: "Greet someone",
    options: [
      { type: 6, name: "user", description: "Who to greet", required: false },
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${process.env.APP_ID}/commands`;
const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${process.env.BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const data = await res.json();
if (!res.ok) {
  console.error(
    "Registration failed:",
    res.status,
    JSON.stringify(data, null, 2),
  );
  process.exit(1);
}
console.log(
  `Registered ${data.length} commands:`,
  data.map((c) => c.name).join(", "),
);
