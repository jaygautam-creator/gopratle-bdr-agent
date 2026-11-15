# Google setup (Sheet + Gmail), about 20 minutes

You need: a Google account, a second Gmail address for the sandbox inbox, and a Google Cloud project (free, no billing needed).

## A. The Sheet
1. Create a blank Google Sheet. Rename its tabs to exactly `Leads`, `Activity_log`, `Config`.
2. In each tab: **File -> Import -> Upload** the matching CSV from `sheet/`, choose **Replace current sheet**.
3. Copy the Sheet id (the part of the URL between `/d/` and `/edit`) into `.env` as `GOOGLE_SHEET_ID`.

## B. Service account (lets the agent read/write the Sheet)
1. https://console.cloud.google.com -> create a project.
2. **APIs & Services -> Library** -> enable **Google Sheets API** and **Gmail API**.
3. **IAM & Admin -> Service Accounts -> Create**. Open it -> **Keys -> Add key -> JSON**. A file downloads.
4. Run `python3 scripts/sa_to_env.py ~/Downloads/<that-file>.json`. It stores the key in `.env` without printing it and tells you the service-account email.
5. In the Sheet, **Share** it with that email as **Editor**.

## C. Gmail (lets the agent send and read replies)
1. **APIs & Services -> OAuth consent screen**: user type External, fill the basics, and **publish the app (In production)**. In *Testing* mode Google expires the login every 7 days.
2. **Credentials -> Create credentials -> OAuth client ID -> Web application**. Add the authorised redirect URI `http://localhost:8085/callback`.
3. Put the client id and secret in `.env` as `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
4. Run `node scripts/gmail_auth.js`, sign in with the Gmail account that will **send** the outreach, and approve. The refresh token is saved to `.env` (never printed). Because the app is unverified, Google shows a warning screen: **Advanced -> Go to ... (unsafe)** is expected for your own app.

## D. Switch on
In `.env`: `STORE_BACKEND=sheets`, `MAIL_BACKEND=gmail`, `SANDBOX_MODE=true`, `SANDBOX_INBOX=<your second gmail>`. Then `make up`.

Smoke test: type `Zomato` / `Gurgaon` in a new row of `Leads` (leave every other column blank) and run workflow 02. The row should get an id, fill in, and an email should land in the sandbox inbox. Reply to it from the sandbox inbox and run workflow 03: the lead becomes `REPLIED`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `Google auth failed` | Wrong or truncated `GOOGLE_SERVICE_ACCOUNT_B64`; re-run `sa_to_env.py` |
| `Sheets API 403` | The Sheet is not shared with the service-account email, or the Sheets API is not enabled |
| `Sheets API 400 ... Unable to parse range` | A tab is misnamed (must be `Leads`, `Activity_log`, `Config`) |
| `Gmail auth failed` | Refresh token revoked or expired (app left in Testing mode); re-run `gmail_auth.js` |
| `SANDBOX_INBOX is not set to a real address` | Set `SANDBOX_INBOX` to a real address you own |
