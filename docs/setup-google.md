# Google setup (Sheet + Gmail), about 20 minutes

You need: a Google account, a second Gmail address for the sandbox inbox, and a Google Cloud project (free, no billing needed).

## A. The Sheet (ONE spreadsheet with three tabs)
1. Create **one** blank Google Sheet (sheets.new). Name it e.g. `GoPratle BDR`. Do **not** import the CSV files as new spreadsheets: that creates separate files, which is not what the agent reads.
2. Copy the Sheet id: it is the long text in the address bar between `/d/` and `/edit`
   (`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`). Put it in `.env` as `GOOGLE_SHEET_ID=THIS_PART` (no quotes, no spaces).
3. You do not need to create the tabs or type headers: `node scripts/init_sheet.js` (step B5) creates the `Leads`, `Activity_log` and `Config` tabs, writes the headers and seeds the settings. The CSVs in `sheet/` are only a reference for the columns.

## B. Service account (lets the agent read/write the Sheet)
1. https://console.cloud.google.com -> pick your project -> **APIs & Services -> Library** -> enable **Google Sheets API** and **Gmail API**.
2. **IAM & Admin -> Service accounts -> Create service account** (any name).
3. Click the service account's email -> **Keys** tab -> **Add key -> Create new key -> JSON -> Create**. A `.json` file downloads. (The list shows "No keys" until you do this. If key creation is blocked, an organisation policy `iam.disableServiceAccountKeyCreation` is enforced: a project owner must turn it off for this project.)
4. Run `python3 scripts/sa_to_env.py ~/Downloads/<that-file>.json`. It stores the key in `.env` without printing it and prints the service-account email.
5. In the Google Sheet click **Share**, paste that email, give it **Editor**, untick "Notify people", **Share**. Then run `node scripts/init_sheet.js`.

## C. Gmail (lets the agent send and read replies)
1. **APIs & Services -> OAuth consent screen**: user type External, fill the basics, and **publish the app (In production)**. In *Testing* mode Google expires the login every 7 days.
2. **Credentials -> Create credentials -> OAuth client ID -> Web application**. Add the authorised redirect URI `http://localhost:8085/callback`.
3. Put the client id and secret in `.env` as `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
4. Run `node scripts/gmail_auth.js`, sign in with the Gmail account that will **send** the outreach, and approve. The refresh token is saved to `.env` (never printed). Because the app is unverified, Google shows a warning screen: **Advanced -> Go to ... (unsafe)** is expected for your own app.

## D. Switch on (test mode: mail only between YOUR OWN addresses)
Use two accounts you control: a **sender** (the Gmail you sign in with in step C4) and a **receiver** (a second inbox that gets the outreach and from which you reply to test the follow-up logic). If one is a school/work (Workspace) account, make the *personal* one the sender: school admins often block unverified OAuth apps.

In `.env`:
```
STORE_BACKEND=sheets
MAIL_BACKEND=gmail
SANDBOX_MODE=true
SANDBOX_INBOX=<the receiver address>
SEND_ALLOWLIST=<the receiver address>,<the sender address>
```
`SEND_ALLOWLIST` is a hard lock: the Gmail backend refuses to send at all while it is empty, and refuses any recipient not on it, in every mode. Nobody else can be emailed. Keep it that way until you deliberately go live.

Then `make up`. Smoke test: type `Zomato` in column C and `Gurgaon` in column D of a new `Leads` row (leave the rest blank) and run workflow 02. The row gets an id and fills in, and the email lands in the receiver inbox. Reply from the receiver and run workflow 03: the lead becomes `REPLIED`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `Google auth failed` | Wrong or truncated `GOOGLE_SERVICE_ACCOUNT_B64`; re-run `sa_to_env.py` |
| `Sheets API 403` | The Sheet is not shared with the service-account email, or the Sheets API is not enabled |
| `Sheets API 400 ... Unable to parse range` | A tab is misnamed. Run `node scripts/init_sheet.js` to create the right tabs |
| `Sheets API 404` | Wrong `GOOGLE_SHEET_ID` (copy it again from the address bar of the **one** spreadsheet) |
| `SEND_ALLOWLIST is empty` / `Blocked: ...` | Add your own test addresses to `SEND_ALLOWLIST`; this lock is intentional |
| `Gmail auth failed` | Refresh token revoked or expired (app left in Testing mode); re-run `gmail_auth.js` |
| `SANDBOX_INBOX is not set to a real address` | Set `SANDBOX_INBOX` to a real address you own |
