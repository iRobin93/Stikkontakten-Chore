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
  {
    name: "foreslå",
    description: "Foreslå en ny oppgave",
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
        description: "Hva bør gjøres?",
        required: true,
        max_length: 300,
      },
    ],
  },

  {
    name: "takk",
    description: "Gi en takk til en annen frivillig",
    options: [
      {
        type: USER,
        name: "bruker",
        description: "Hvem vil du takke?",
        required: true,
      },
      {
        type: STRING,
        name: "melding",
        description: "En liten hilsen (valgfri)",
        max_length: 200,
      },
    ],
  },
  {
    name: "ide",
    description: "Send inn en anonym idé",
    options: [
      {
        type: STRING,
        name: "tekst",
        description: "Hva er ideen din?",
        required: true,
        max_length: 500,
      },
    ],
  },
  {
    name: "ny-gjest",
    description: "Meld at du tok med en ny besøkende",
    options: [
      {
        type: STRING,
        name: "merknad",
        description: "Valgfritt: kort merknad, ikke fullt navn",
        max_length: 100,
      },
    ],
  },
  { name: "leaderboard", description: "Se månedens aktive (hvis slått på)" },

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
    name: "mal-ny",
    description: "Lag mal for gjentakende oppgave (admin/leder)",
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
        type: STRING,
        name: "intervall",
        description: "Hvor ofte?",
        required: true,
        choices: [
          { name: "Ukentlig", value: "weekly" },
          { name: "Månedlig", value: "monthly" },
          { name: "Kvartalsvis", value: "quarterly" },
        ],
      },
      {
        type: INTEGER,
        name: "dag",
        description:
          "Ukentlig: ukedag 1-7 (1 = mandag). Ellers: dag i måneden 1-28",
        required: true,
        min_value: 1,
        max_value: 28,
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
        type: INTEGER,
        name: "fristdager",
        description: "Frist: antall dager etter at oppgaven åpner",
        min_value: 1,
        max_value: 365,
      },
    ],
  },
  { name: "mal-liste", description: "Se alle maler (admin/leder)" },
  {
    name: "mal-slett",
    description: "Slett en mal (admin)",
    options: [
      {
        type: STRING,
        name: "mal",
        description: "Hvilken mal?",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "møte",
    description: "Opprett et møte med påmelding og innsjekk (admin/leder)",
    options: [
      {
        type: STRING,
        name: "tittel",
        description: "Hva er møtet?",
        required: true,
        max_length: 80,
      },
      {
        type: STRING,
        name: "klokkeslett",
        description: "Starttid som TT:MM (norsk tid)",
        required: true,
      },
      {
        type: STRING,
        name: "dato",
        description: "ÅÅÅÅ-MM-DD (standard: i dag)",
      },
      {
        type: INTEGER,
        name: "plasser",
        description: "Antall frivillig-plasser (standard 20)",
        min_value: 1,
        max_value: 200,
      },
    ],
  },
  {
    name: "innstillinger",
    description: "Se eller endre innstillinger (admin)",
    options: [
      {
        type: STRING,
        name: "innstilling",
        description: "Hvilken innstilling? (la stå tom for å se alle)",
        autocomplete: true,
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
