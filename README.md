# KME Apps

Private analytics for all of Kollin's apps, in one place:

- **Visits** for every app that loads the tracker: visits, people (devices), new people, pages, how they open it (iPhone app, Home Screen, browser), countries, where they came from.
- **Errors** your users hit, grouped, with how many people and when.
- **Sports Hub sign-ups**: every account (email, joined, last active, teams) and every team (plan, owner, people).
- **App Store downloads**: first-time downloads, redownloads, updates and in-app purchases per app, by day and country.

One Cloudflare Worker (`kme-apps`) serves the dashboard and stores data in the D1 database `kme-apps`. It's locked with one username and password.

## Setup (all from a phone)

1. **Deploy:** Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → `keubanks16/KMEApps`. Leave everything as is and deploy. The Worker is `kme-apps` and lives at `https://kme-apps.<your-subdomain>.workers.dev`.
2. **Login:** Worker → Settings → Variables and Secrets → add two **Secrets**:
   - `KME_USER`: your username
   - `KME_PASSWORD`: a strong password
3. **Sports Hub sign-ups:** add Secret `FIREBASE_SERVICE_ACCOUNT` = the whole service account JSON. Get it from Firebase console → Project settings → Service accounts → Generate new private key (the same kind of file the Sports Hub Worker uses).
4. **App Store downloads:** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, access **Sales** (or Admin). Download the .p8 once. Add Secrets:
   - `ASC_KEY_ID`: the key's ID
   - `ASC_ISSUER_ID`: the Issuer ID shown above the keys
   - `ASC_PRIVATE_KEY`: the whole text of the .p8 file
   - `ASC_VENDOR`: your vendor number (App Store Connect → Payments and Financial Reports, top left)
   Then open KME Apps → App Store → **Sync now** to load the last 30 days. After that it syncs every morning.
5. **Tracker:** KME Apps → Setup lists the one line to add to each app's `<head>`:
   `<script src="https://kme-apps.<subdomain>.workers.dev/kme.js" data-app="sports-hub" defer></script>`

## Privacy

The tracker keeps a random device id in the browser and the country Cloudflare reports. No names, emails or IP addresses. Bots are skipped. Visits older than 400 days are deleted.
