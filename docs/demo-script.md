# Demo recording script (about 3 minutes)

**Before recording:** Google setup done ([setup-google.md](setup-google.md)); `.env` has `STORE_BACKEND=sheets`, `MAIL_BACKEND=gmail`, `SANDBOX_MODE=true`, `FOLLOWUP_DELAY_MINUTES=2`; `make up`, `make import`; in n8n switch **Active** on for workflows 01, 02, 03 and 99. Arrange the screen: Telegram, the Google Sheet, n8n (Executions), and the sandbox Gmail inbox.

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the Sheet (empty Leads tab) and n8n's four workflows | "One queue, four workflows. Telegram or the Sheet adds a lead; everything else is automatic." |
| 0:20 | In Telegram send `Find event leads for Zomato in Gurgaon` | "Same command as the brief." The bot replies "Queued LD-0001" within 20 s |
| 0:40 | Open n8n -> Executions; show workflow 02 running, click a node to show its output | "It finds the company site, searches for the Founder/HR/Events person, finds an email, and asks Gemini for the pitch." |
| 1:10 | Show the Sheet row filled in: contact, title, email + its source, confidence, sources, 3-line pitch; open Activity_log | "Every claim has a source. The email is labelled `guessed` and the confidence is capped accordingly." |
| 1:35 | Telegram result card; open the sandbox Gmail inbox and the email | "Sandbox mode: it went to my test inbox, with the intended recipient in the banner. Real sending needs two explicit settings." |
| 1:55 | Wait for the follow-up (2 min in demo mode); show it arriving **in the same thread** | "Follow-up is scheduled by scanning the Sheet, not a long Wait node." |
| 2:15 | Run it for `Swiggy`/`Bengaluru`, then reply to that email from the sandbox inbox; run workflow 03 | "A reply cancels the follow-up and marks the lead REPLIED." |
| 2:40 | Send `Find event leads for Xqzvbnm Holdings in Pune` and `Apple in Gurgaon` | "Fake company -> NOT_FOUND. Ambiguous or no qualifying contact -> NEEDS_REVIEW. Nothing is sent." |
| 2:55 | Show `make test` passing | "68 tests, including the failure paths." |

Tip: do a dry run first so Tavily/Gemini quota is not wasted on retakes (each lead uses ~3-4 searches and 2 Gemini calls).
