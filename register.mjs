const commands = [
  { name: "ping", description: "Replies with pong" },
  {
    name: "chores",
    description: "Volunteer chores",
    options: [
      {
        type: 1,
        name: "add",
        description: "Add a chore (organizers only)",
        options: [
          {
            type: 3,
            name: "name",
            description: "What needs doing",
            required: true,
          },
          {
            type: 3,
            name: "date",
            description: "Date as YYYY-MM-DD",
            required: true,
          },
          {
            type: 4,
            name: "spots",
            description: "How many volunteers (default 1)",
            min_value: 1,
            max_value: 50,
          },
        ],
      },
      { type: 1, name: "list", description: "Show upcoming chores" },
      {
        type: 1,
        name: "signup",
        description: "Claim a spot on a chore",
        options: [
          {
            type: 3,
            name: "id",
            description: "Chore ID from /chores list",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "drop",
        description: "Give up your spot on a chore",
        options: [
          { type: 3, name: "id", description: "Chore ID", required: true },
        ],
      },
      { type: 1, name: "mine", description: "Show chores you signed up for" },
      {
        type: 1,
        name: "remove",
        description: "Delete a chore (organizers only)",
        options: [
          { type: 3, name: "id", description: "Chore ID", required: true },
        ],
      },
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
