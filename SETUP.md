# Oppsett – fase 1 til 5

## 1. DynamoDB-tabell (manuelt i konsollen)

**Tabellnavn:** `frivillig` (Lambdaen leser navnet fra `TABLE_NAME`)
**Capacity:** On-demand

| Nøkkel        | Attributt | Type   |
| ------------- | --------- | ------ |
| Partition key | `PK`      | String |
| Sort key      | `SK`      | String |

**GSI1** – oppgaver og innsjekk

- Navn: `GSI1`, partition key `GSI1PK` (String), sort key `GSI1SK` (String), projection **All**

**GSI2** – «mine ting»

- Navn: `GSI2`, partition key `GSI2PK` (String), sort key `GSI2SK` (String), projection **All**

(GSI-navnene må være nøyaktig `GSI1` og `GSI2`.) Den gamle prototype-tabellen (nøkkel `id`) kan ikke gjenbrukes.

## 2. IAM (Lambdaens rolle)

Erstatt region/konto. Gir tilgang til kun denne tabellen og indeksene:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-north-1:<KONTO-ID>:table/frivillig",
        "arn:aws:dynamodb:eu-north-1:<KONTO-ID>:table/frivillig/index/*"
      ]
    }
  ]
}
```

Transaksjoner (`TransactWriteItems`) krever ikke egne rettigheter utover Put/Update/Delete på elementene.

**I tillegg: tillatelse til å starte seg selv i bakgrunnen.** Etter en godkjenning kjører botten bildepublisering, DM og nivåoppdatering som en bakgrunnsjobb, så knappen svarer innen Discords 3 sekunder. Legg til en ekstra statement i samme policy (erstatt region, konto og funksjonsnavn):

```json
{
  "Effect": "Allow",
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:eu-north-1:<KONTO-ID>:function:<LAMBDA-NAVN>"
}
```

Uten denne tillatelsen virker godkjenning og poeng som vanlig, men bildet blir ikke publisert i bildekanalen, og det står en advarsel i godkjenningsmeldingen. Pakken `@aws-sdk/client-lambda` følger med Node 22-runtimen i Lambda, så du trenger ikke legge den til i `package.json`.

## 3. Lambda

- Runtime Node.js 22, handler `index.handler`
- Timeout **60 s**, minne **256 MB** eller mer (bildepublisering og innsjekk-jobben kan bruke litt tid)
- **Function URL**, auth type `NONE`. Lim URL-en inn som _Interactions Endpoint URL_ i Discord Developer Portal.

**Miljøvariabler**

| Navn                  | Innhold                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `TABLE_NAME`          | `frivillig`                                                                           |
| `DISCORD_PUBLIC_KEY`  | Public key fra Developer Portal                                                       |
| `DISCORD_TOKEN`       | Bot-token                                                                             |
| `ADMIN_ROLE_ID`       | ID til admin-rollen                                                                   |
| `LEADER_ROLE_ID`      | ID til rollen «Voksen leder»                                                          |
| `ADMIN_CHANNEL_ID`    | (valgfri) kanal for godkjenninger – kan i stedet settes med `/innstillinger`          |
| `FALLBACK_CHANNEL_ID` | (valgfri) reservekanal hvis DM er stengt                                              |
| `GUILD_ID`            | Server-ID. **Påkrevd for nivå-roller** (boten gir og fjerner roller i denne serveren) |
| `VOLUNTEER_ROLE_ID`   | (valgfri) ID til Frivillig-rollen, kan i stedet settes med `/innstillinger`           |
| `PHOTO_CHANNEL_ID`    | (valgfri) bildekanalen, kan i stedet settes med `/innstillinger`                      |
| `SHOUTOUT_CHANNEL_ID` | (valgfri) kanal for månedens frivillige, kan settes med `/innstillinger`              |
| `SUMMARY_CHANNEL_ID`  | (valgfri) kanal for ukesoppsummering. Uten den brukes admin-kanalen                   |

Brukere med Discord-tillatelsen **Administrator** regnes også som admin.

Botten trenger tillatelsene _Send Messages_ og _Embed Links_ i admin-kanalen, i oppsummeringskanalen og i kanalene der `/møte` brukes (møtemeldingen postes av botten).

## 4. EventBridge (fire planlagte jobber)

Opprett fire schedules i EventBridge Scheduler, alle med Lambdaen som target og **konstant input**. Sett tidssone **Europe/Oslo** på de tre siste.

| Navn                | Schedule                                          | Input                  |
| ------------------- | ------------------------------------------------- | ---------------------- |
| `frivillig-checkin` | `rate(1 hour)`                                    | `{ "job": "checkin" }` |
| `frivillig-nightly` | `cron(0 3 * * ? *)` (hver natt kl. 03:00)         | `{ "job": "nightly" }` |
| `frivillig-weekly`  | `cron(0 8 ? * MON *)` (mandag kl. 08:00)          | `{ "job": "weekly" }`  |
| `frivillig-monthly` | `cron(0 9 1 * ? *)` (den 1. hver måned kl. 09:00) | `{ "job": "monthly" }` |

- `nightly` oppretter oppgaver fra maler og varsler admin om oppgaver ingen har tatt.
- `monthly` kårer månedens frivillige og poster en shoutout. Den kan trygt kjøres flere ganger samme måned.
- `weekly` poster ukesoppsummeringen. Den kan trygt kjøres flere ganger samme uke (den poster bare én gang).
- Ingen nye indekser eller IAM-rettigheter trengs for fase 2.

## 5. GitHub

- Legg til environment-variabelen `GUILD_ID` (Settings → Environments → Dev/Prod → Variables) så kommandoene registreres som guild-kommandoer.
- `package.json` trenger ingen endringer: koden bruker de samme tre pakkene som før (`discord-interactions`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`).
- Gamle globale kommandoer (f.eks. `/chores`) fra prototypen ligger igjen når du bruker guild-kommandoer. Fjern dem én gang:
  `curl -X PUT -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" -d '[]' https://discord.com/api/v10/applications/$APP_ID/commands`

## 6. Første gangs bruk

1. `/innstillinger innstilling:Admin-kanal verdi:<kanal-ID>`
2. `/innstillinger` for å se og endre poeng per størrelse, maks aktive oppgaver og dager før innsjekk. **Poengene er plassholdere (10/25/50) til du setter dine egne.**
3. `/oppgave-ny` for å lage en testoppgave, deretter `/oppgaver`.

## Fase 2: slik fungerer det

**Maler** (`/mal-ny`, `/mal-liste`, `/mal-slett`)

- Intervall: ukentlig (dag 1–7, 1 = mandag), månedlig eller kvartalsvis (dag 1–28 i første måned i kvartalet).
- Nattjobben legger ut oppgaven når perioden har startet, og bare én gang per periode. Lager du en mal midt i en periode, legges oppgaven ut med en gang hvis dagen allerede har passert.
- Når en ny oppgave åpnes, fjernes forrige periodes oppgave **hvis ingen hadde tatt den**. Oppgaver noen har meldt seg på, blir liggende.
- Alle poengverdier og plasser kopieres fra malen når oppgaven opprettes. Endringer i `/innstillinger` påvirker ikke eksisterende maler.
- Rotasjon er ikke innført (felt `rotation: "none"` ligger klart i malen).

**Møter** (`/møte`)

- Tidspunkt oppgis i norsk tid. Møtemeldingen har knappene Meld meg på / Meld meg av / Jeg er her.
- «Jeg er her» virker bare for påmeldte, fra 15 min før start til 3 timer etter start (justerbart i `/innstillinger`), og gir poeng én gang.

**Forslag** (`/foreslå`)

- Går til admin-kanalen. Ved godkjenning fyller admin inn størrelse (og eventuelt poeng og plasser) i et skjema, og oppgaven publiseres. Forslagsstilleren får DM.

**Ukesoppsummering**

- Teller oppgaver godkjent forrige kalenderuke. Oppgaver godkjent før fase 2 ble tatt i bruk, er ikke med i tallene.

## Fase 3: slik fungerer det

**Nivåer og roller**

- Nivå beregnes av `totalEarned`: Rekrutt (start), Veteran og Legende. Grensene settes i `/innstillinger` (plassholdere: 100 og 500).
- For automatiske Discord-roller: lag tre roller, sett IDene i `/innstillinger` (Discord-rolle: Rekrutt/Veteran/Legende), og sett `GUILD_ID` på Lambdaen.
- Botten trenger tillatelsen **Manage Roles**, og botens egen rolle må ligge **over** nivårollene i rollelisten (Serverinnstillinger → Roller, dra den opp).
- Nivået oppdateres når poeng endres. Endrer du grensene, oppdateres folk første gang de får poeng etterpå.

**Streak og multiplikator**

- En streak-uke teller når personen har en **godkjent oppgave** eller en **møteinnsjekk** den uken (uka starter mandag, tidssone Oslo).
- +0,1 per uke på rad, maks +0,5 og maks ×1,5 totalt. Hver hele uke uten oppmøte tar streaken ned **ett trinn** (den nullstilles ikke).
- Multiplikatoren gjelder **alle poeng** som deles ut automatisk: oppgaver, møter, takk, ideer og ny-gjest. Manuelle justeringer med `/poeng-juster` ganges ikke.
- Låses i det poengene deles ut, og lagres i loggen (`basePoints`, `multiplier`, `delta`). Tallene (`streakStep`, `streakMax`, `multiplierCap`) kan endres i `/innstillinger`.
- Ikke innført: «fritt hopp» per kvartal og de andre multiplikatorkildene fra README (de var ikke besluttet).

**Takk** (`/takk`): gir små poeng (standard 2), maks 3 per uke per giver, og bare én gang til samme person per uke.

**Ideboks** (`/idé`): admin-kanalen ser ideen uten avsender. Ved «Tatt i bruk» velger admin poeng, og avsenderen får dem automatisk. Avsender lagres internt i databasen, men vises aldri i Discord.

**Ny besøkende** (`/ny-gjest`): den frivillige melder fra (valgfri kort merknad, bruk ikke fullt navn), og admin/leder bekrefter med knapp at personen møtte opp. Merknaden slettes når admin har tatt stilling. Maks 3 meldinger per uke.

**Månedens frivillige:** `monthly`-jobben henter månedens poeng og poster en shoutout (ved likt poengtall nevnes opptil tre). `/leaderboard` er **av som standard**; slå den på med `/innstillinger innstilling:Toppliste verdi:1`.

**Bildekanal:** sett «Bildekanal» i `/innstillinger`. Ved godkjenning lastes bildet ned og postes på nytt i kanalen (uten navn), siden Discord-lenker utløper. Botten trenger _Attach Files_ i bildekanalen. Dette skjer i en bakgrunnsjobb (se IAM over), så godkjenningen svarer med en gang selv om bildet er stort. Er originalen over grensen, ber botten Discord om en nedskalert versjon (maks 2560 px på lengste side, som WebP) og poster den i stedet. Grensen er innstillingen «Bilde: maks størrelse i MB» (standard 9,5, siden en server uten boost tar imot ca. 10 MB). Har serveren boost, kan du øke den. Hvis det feiler, får admin-kanalen en advarsel, og poengene er likevel delt ut.

**Innstillinger:** det er nå mange, så `innstilling` bruker autocomplete. Skriv f.eks. «poeng» eller «streak» for å finne dem.

## Fase 4: slik fungerer det

**`/oppgave-rediger`** (admin/leder)

- Velg en åpen oppgave fra listen, og fyll inn bare feltene du vil endre: `tittel`, `beskrivelse`, `størrelse`, `plasser`, `poeng`, `frist` (`ÅÅÅÅ-MM-DD`, eller `ingen` for å fjerne fristen).
- **Plasser** kan ikke settes lavere enn antall som allerede har tatt eller fullført en plass. Øker du antallet, rykker de på venteliste opp automatisk og får DM.
- **Størrelse** endrer ikke poengene av seg selv. Bruk `poeng` hvis de skal endres. Nye poeng gjelder også ferdigmeldinger som ennå ikke er godkjent.
- Endres tittel, beskrivelse eller frist, får påmeldte og de på venteliste en DM.
- Opprykk og DM-er kjører i en bakgrunnsjobb, så det krever `lambda:InvokeFunction` (se IAM over).

**`/eksport`** (bare admin)

- Velg `type`: **Alt**, Frivillige, Oppgaver, Poenglogg eller Møter. `fra` og `til` (`ÅÅÅÅ-MM-DD`, inklusive, norsk tid) avgrenser oppgaver, poenglogg og møter. De brukes ikke for Frivillige.
- **Format (`format`):** standard er **Excel (.xlsx)** med én fane per type. «Alt» gir én fil med fire faner (Frivillige, Oppgaver, Poenglogg, Møter). Tomme typer får en fane med bare overskrifter. Velg `format:csv` for CSV i stedet (én fil per type).
- Filen lages i en bakgrunnsjobb og sendes som vedlegg på **DM** til den som kjørte kommandoen. Er DM stengt, havner den i admin-kanalen.
- `brukernavn:ja` legger til en kolonne med navn. Boten bruker kallenavnet på serveren hvis `GUILD_ID` er satt på Lambdaen, ellers det globale brukernavnet. De som har forlatt serveren, markeres. Får boten ikke hentet navn, står det i meldingen sammen med årsaken. Standard er bare Discord-ID.
- **Excel-filen** har fet og frosset overskriftsrad, filter, passende kolonnebredder og ekte datoer og tall (klar for pivottabeller). **ID-er (Discord-ID, oppgave-ID, mal-ID) lagres som tekst**, så Excel og Google Sheets ikke avrunder eller omformer dem. Tekst tolkes aldri som formel. Filen lages uten eksterne pakker, så `package.json` trenger ingen endring.
- **CSV-filen** bruker semikolon, komma som desimaltegn og UTF-8 med BOM. ID-er skrives som `="…"` så de vises riktig ved dobbeltklikk. Importerer du CSV via Power Query, bruk heller xlsx. Tekst som starter med `=`, `+`, `-` eller `@` får en apostrof foran.
- I Google Sheets: Fil → Importer → Last opp → velg xlsx-filen. Alle faner kommer med.
- Eksporten henter data med en **Scan** av tabellen, så Lambdaen trenger `dynamodb:Scan` (lagt til i policyen over). 160 000 poengrader tar ca. 2 sekunder å bygge.
- Filer over ca. 10 MB kan ikke sendes på Discord. Xlsx er komprimert og blir langt mindre enn CSV (160 000 poengrader ≈ 4,6 MB mot over 10 MB). Er filen likevel for stor, sier boten fra. Avgrens da perioden.
- Eksporten inneholder personopplysninger. Del den ikke videre, og slett den fra DM når du er ferdig.

## Fase 5: «Bli frivillig»-knapp og rollekrav

Boten kan ikke lese emoji-reaksjoner (det krever en permanent tilkobling til Discord, og boten kjører på Lambda). Derfor brukes en **knapp** som gir rollen, som virker likt for brukeren.

**Oppsett i riktig rekkefølge**

1. Lag en rolle, f.eks. `Frivillig` (Serverinnstillinger → Roller). Den trenger ingen spesielle tillatelser.
2. Botten trenger tillatelsen **Manage Roles**, og botens egen rolle må ligge **over** Frivillig-rollen i rollelisten.
3. `/innstillinger innstilling:Discord-rolle: Frivillig verdi:@Frivillig` (du kan lime inn rollen eller ID-en).
4. `/frivillig-synk` gir rollen til alle som allerede har poeng, så ingen faller utenfor når kravet gjelder. Du får en DM med resultatet. (Krever `lambda:InvokeFunction`, se IAM.)
5. Gå til kanalen der folk skal melde seg (f.eks. `#bli-frivillig`, lesbar for alle) og skriv `/frivillig-knapp`. Fest meldingen. Du kan skrive egen tekst med `tekst:`.
6. Test med en vanlig konto uten rollen.

**Hva som krever rollen**

- Er `Discord-rolle: Frivillig` satt, må man ha rollen for å: melde seg på oppgaver, ferdigmelde, delta på møter (påmelding og innsjekk), sende `/idé` og `/ny-gjest`, og gi eller få `/takk`.
- Alle kan fortsatt se `/oppgaver` og `/poeng`, og bruke `/foreslå`. Den som mangler rollen får en beskjed som peker til knappen.
- Er innstillingen ikke satt, virker alt som før.
- Admin og ledere trenger også rollen hvis de selv skal samle poeng.

**Slutt som frivillig**

- Knappen «Slutt som frivillig» tar bort rollen. Den avvises hvis personen har aktive oppgaver, ventelisteplass eller ferdigmeldinger som venter på godkjenning. Poengene beholdes.

**Hvis noe feiler**

- Får boten ikke gitt rollen, ser brukeren en høflig beskjed, og admin-kanalen får en melding med årsak (mangler _Manage Roles_, eller rollen ligger over botens).
- `/innstillinger … verdi:ingen` fjerner innstillingen og slår rollekravet av igjen.

## Kjente begrensninger i fase 1

- Bilder i `/ferdig` lagres som Discord-CDN-lenker, som utløper. Bildet i admin-meldingen kan derfor bli borte etter en stund. Ved godkjenning ber botten Discord om en fersk lenke før bildet postes på nytt i bildekanalen.
- Alt svares direkte innen 3 sekunder. Lambda kan ikke fortsette arbeid etter at svaret er sendt, så deferred response (type 5) brukes først når noe blir tungt (da via asynkron self-invoke).
- `/oppgave-rediger` er ikke med ennå.
- Poengjusteringer endrer både saldo og `totalEarned`, siden det ikke finnes noe poengforbruk i fase 1.
