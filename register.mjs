// Registrerer slash-kommandoer mot Discord. Kjøres ved endringer i kommandoene (GitHub Actions).
// Med GUILD_ID satt registreres guild-kommandoer (oppdateres umiddelbart). Uten: globale kommandoer.

const STRING = 3;
const INTEGER = 4;
const USER = 6;
const ATTACHMENT = 11;

const commands = [
  // ---- Frivillig ----
  { name: "oppgaver", description: "Se og ta ledige oppgaver" },
  { name: "mine-oppgaver", description: "Se og slipp dine egne oppgaver" },
  {
    name: "ferdig",
    description: "Meld en oppgave som ferdig",
    options: [
      {
        type: STRING,
        name: "oppgave",
        description: "Hvilken oppgave er du ferdig med?",
        required: true,
        autocomplete: true,
      },
      {
        type: ATTACHMENT,
        name: "bilde",
        description: "Bilde av oppgaven (ikke av personer)",
      },
    ],
  },
  { name: "poeng", description: "Se dine poeng" },

  // ---- Admin/leder ----
  {
    name: "oppgave-ny",
    description: "Opprett en ny oppgave (admin/leder)",
    options: [
      {
        type: STRING,
        name: "tittel",
        description: "Kort tittel",
        required: true,
        max_length: 80,
      },
      {
        type: STRING,
        name: "beskrivelse",
        description: "Hva må gjøres?",
        required: true,
        max_length: 300,
      },
      {
        type: STRING,
        name: "størrelse",
        description: "Hvor stor er oppgaven?",
        required: true,
        choices: [
          { name: "Lite", value: "small" },
          { name: "Middels", value: "medium" },
          { name: "Stort", value: "large" },
        ],
      },
      {
        type: INTEGER,
        name: "plasser",
        description: "Antall plasser (standard 1)",
        min_value: 1,
        max_value: 50,
      },
      {
        type: INTEGER,
        name: "poeng",
        description: "Overstyr poeng fra størrelsen",
        min_value: 0,
        max_value: 10000,
      },
      {
        type: STRING,
        name: "frist",
        description: "Frist som ÅÅÅÅ-MM-DD (valgfri)",
      },
    ],
  },
  {
    name: "oppgave-slett",
    description: "Fjern en åpen oppgave (admin)",
    options: [
      {
        type: STRING,
        name: "oppgave",
        description: "Hvilken oppgave?",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "poeng-juster",
    description: "Juster en brukers poeng (admin)",
    options: [
      { type: USER, name: "bruker", description: "Hvem?", required: true },
      {
        type: INTEGER,
        name: "antall",
        description: "Antall poeng (negativt for å trekke)",
        required: true,
        min_value: -10000,
        max_value: 10000,
      },
      {
        type: STRING,
        name: "begrunnelse",
        description: "Hvorfor?",
        required: true,
        max_length: 200,
      },
    ],
  },
  {
    name: "logg",
    description: "Se poenglogg for en bruker (admin)",
    options: [
      { type: USER, name: "bruker", description: "Hvem?", required: true },
    ],
  },
  {
    name: "innstillinger",
    description: "Se eller endre innstillinger (admin)",
    options: [
      {
        type: STRING,
        name: "innstilling",
        description: "Hvilken innstilling?",
        choices: [
          { name: "Dager før innsjekk", value: "checkinDays" },
          {
            name: "Maks aktive oppgaver (0 = ingen grense)",
            value: "maxActiveTasks",
          },
          { name: "Poeng: lite", value: "pointsSmall" },
          { name: "Poeng: middels", value: "pointsMedium" },
          { name: "Poeng: stort", value: "pointsLarge" },
          { name: "Admin-kanal (godkjenning)", value: "adminChannelId" },
          {
            name: "Reservekanal (innsjekk uten DM)",
            value: "fallbackChannelId",
          },
        ],
      },
      { type: STRING, name: "verdi", description: "Ny verdi" },
    ],
  },
];

const { APP_ID, BOT_TOKEN, GUILD_ID } = process.env;
const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(url, {
  method: "PUT", // erstatter hele settet, så gamle kommandoer (f.eks. /chores) fjernes i dette scopet
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
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
  `Registrerte ${data.length} kommandoer (${GUILD_ID ? "guild" : "global"}):`,
  data.map((c) => c.name).join(", "),
);
