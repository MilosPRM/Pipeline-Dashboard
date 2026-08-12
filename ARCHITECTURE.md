# Pipeline CRM - Architecture

Working document. It defines the data model and the API contract for the CRM we are
building. The rule that matters: **the front end only ever talks to the API contract**,
never directly to a spreadsheet, a CSV or a database. That is what lets us change the
storage engine later without rewriting the interface.

## Layers

| Layer | What it is | Where it lives |
| --- | --- | --- |
| UI | Static HTML/CSS/JS, no build step | `/index.html`, served by Netlify CDN |
| API | Netlify Functions, Node 20 | `/netlify/functions/*`, routed at `/api/*` |
| Storage | Google Sheets today, Postgres later | Only the API layer knows which |

All credentials live in Netlify environment variables and are read by the API layer only.
Nothing secret is ever included in a file that is served to a browser.

## Data model

Six entities. Today `deal` is the only one that physically exists (as the Master Sheet);
the others are added in order.

### deal

The opportunity itself. One row per property under consideration.

    id              string   stable identifier, never reused
    name            string   property name
    address         string   full street address
    state           string   2-letter code
    year_built      int
    units           int
    asking_price    number   null when unpriced
    price_per_unit  number   derived: asking_price / units
    stage           enum     New Deal | Reviewing | Underwriting | LOI | Under Contract | Closed | Passed
    priority        enum     New | Low | Medium | High
    source          string   broker shop or channel
    listing_url     string
    folder_url      string   link to the deal folder
    contact_id      fk       -> contact.id  (replaces the free-text broker columns)
    owner_id        fk       -> user.id     who on our side owns it
    created_at      datetime
    updated_at      datetime

### contact

A person. Today the broker name, email and phone are copied onto every deal row, so the
same broker exists dozens of times over. Splitting this out is the single biggest
improvement in the whole model - it is what makes "show me everything this broker sent us"
possible.

    id              string
    first_name      string
    last_name       string
    email           string   unique, lowercased
    phone           string
    title           string
    org_id          fk       -> organisation.id
    notes           text
    created_at      datetime

### organisation

A brokerage, lender, seller or vendor. "JLL", "Berkadia", "Walker & Dunlop".

    id              string
    name            string   unique
    type            enum     Brokerage | Seller | Lender | Vendor | Other
    website         string

### activity

The timeline. Every call, email, meeting, note and site visit, attached to a deal and
optionally to a contact. Append-only - activities are never edited in place, which is what
gives us a real audit trail.

    id              string
    deal_id         fk       -> deal.id
    contact_id      fk       -> contact.id   nullable
    type            enum     note | email | call | meeting | site_visit | stage_change | system
    subject         string
    body            text
    occurred_at     datetime
    created_by      fk       -> user.id
    created_at      datetime

### task

Follow-ups. "Chase Caleb for the T-12 on Thursday."

    id              string
    deal_id         fk       -> deal.id      nullable
    contact_id      fk       -> contact.id   nullable
    title           string
    due_date        date
    done            bool
    assignee_id     fk       -> user.id

### document

Pointers to files, not the files themselves - Drive stays the document store for now.

    id              string
    deal_id         fk       -> deal.id
    label           string   "OM", "Rent roll", "T-12", "Underwriting model"
    url             string
    added_at        datetime

## API contract

Everything under `/api`. JSON in, JSON out. Errors return
`{ ok: false, error: "..." }` with a real HTTP status.

    GET    /api/deals                 list, supports ?stage= &priority= &q= &limit= &cursor=
    GET    /api/deals/:id             single deal, with contact + activity count
    POST   /api/deals                 create
    PATCH  /api/deals/:id             partial update (stage, priority, any field)

    GET    /api/contacts              list
    GET    /api/contacts/:id          single contact + their deals
    POST   /api/contacts              create
    PATCH  /api/contacts/:id          update

    GET    /api/deals/:id/activities  timeline for a deal, newest first
    POST   /api/activities            log a note, call, email, meeting

    GET    /api/tasks                 ?open=1 &assignee= &due_before=
    POST   /api/tasks                 create
    PATCH  /api/tasks/:id             mark done, reschedule

Successful responses are `{ ok: true, data: ... }`. Lists also return
`{ total, cursor }` so the UI can paginate once the dataset outgrows a single fetch.

## Rules we are not going to break

1. No secret ever appears in a file the browser can download.
2. The UI never talks to Google, Postgres or any third party directly - only to `/api`.
3. Every write goes through the API so it can be validated, authorised and logged.
4. Stage changes always write an `activity` row. History is never silently lost.
5. Schema changes are additive. Unknown columns are carried through, not dropped -
   the pipeline is still evolving and the app must tolerate that.

## Roadmap

**Phase 1 - secure the plumbing (in progress).** Introduce the API layer. Move the write
token out of the page and into Netlify environment variables. Front end switches from
reading a public CSV to calling `/api/deals`. No visible change to the user, but the
credentials stop being public.

**Phase 2 - become a CRM.** Contacts and organisations as real records with their own
views. Activity timeline on each deal. Notes and follow-up tasks. A "my open tasks" view.

**Phase 3 - real storage and real logins.** Move from Sheets to Postgres. Add Google
sign-in restricted to our own domain, so the site stops being publicly readable. Keep a
one-way export back to Sheets for anyone who prefers a grid.

**Phase 4 - leverage.** Log sent email against the deal automatically. Pull new listings
out of broker emails into draft deal records instead of typing them in.

## Environment variables

Set in Netlify under Project configuration -> Environment variables. Never committed.

    SHEET_CSV_URL        published CSV endpoint for the Master Sheet
    APPS_SCRIPT_URL      Apps Script web app /exec URL
    APPS_SCRIPT_TOKEN    shared secret the Apps Script checks on every write

