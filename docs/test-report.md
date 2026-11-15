# Test report

Run on 2026-11-15 against live Gemini, Tavily and Telegram, with a real n8n 2.47 in Docker.

## 1. Automated tests: 81 passing (`make test`, no network, no quota)

| Area | What is checked |
|---|---|
| `lib` | Command parsing (brief's example + variants + junk), de-dupe keys, domain parsing, email extraction, role scoring by company size, candidate and pitch validators, template pitch always valid, prompt-data wrapping, loose JSON parsing |
| Pipeline | Happy path; hallucinated person dropped; array-wrapped LLM JSON; search outage -> `FAILED`; LLM down -> template pitch; 429 falls to the fallback model; weak match -> `NOT_FOUND`; generic exec rejected; aggregator-first results rescued by retry; Serper takes over from Tavily |
| Approval gate | A finished draft is not sent and later runs do not send it; approve (typed or button) sends; reject sends nothing and cannot be undone; strangers and unknown ids change nothing; fails closed; Approve / Reject buttons are on the card, taps are answered, buttons removed, double tap harmless |
| Agent | Intake (queue, reject strangers, de-dupe, gibberish, LLM parse cannot invent values, /status, /help); full path to `SENT`; sandbox redirect and double-flag rule; placeholder inbox refused; send failure retried with no extra API calls; `NEEDS_REVIEW` then human approval; hand-typed rows adopted; duplicates marked; stuck-row recovery; follow-up in the same thread; reply cancels it; failed reply check does not follow up |
| Google adapters | Service-account JWT signature verified against the public key; token cached; append / adopt / partial update / reordered header; Config and internal state; batched activity log; revoked credentials give clear errors; Gmail RFC 2822 message, threading, reply detection ignores our own messages |
| n8n sandbox | Modules load in a vm context with no `URL`, `URLSearchParams` or `fetch` |
| Workflows | Connections valid; every Code node compiles; no secret from `.env` is embedded; generated JSON is in sync with `src/`; Sheet CSV headers match the code; compose passes every env var |

## 2. Live pipeline results (real APIs, nothing sent to a real lead)

| Input | Result | Notes |
|---|---|---|
| Zomato / Gurgaon | `SENT` (sandbox) | Saurabh Jain, Manager - People Analytics; email `guessed`; confidence 0.7; about 8 s |
| Razorpay / Bengaluru | `SENT` (sandbox), inside n8n | Harshil Mathur, CEO and Co-founder; `guessed`; 0.7 |
| Swiggy / Bengaluru | `SENT` (sandbox), inside n8n | Girish Menon, Head HR; `guessed`; 0.7 |
| Apple / Gurgaon | `NEEDS_REVIEW` | No Founder/HR/Events contact found; nothing sent |
| Xqzvbnm Holdings / Pune | `NOT_FOUND` | Could not verify the company exists; nothing sent |

## 3. Verified inside n8n (real executions)

| Workflow | Verified |
|---|---|
| 02 Lead processor | Full run from a Sheet-style row to `SENT`; resend path after a refused send (no new API calls) |
| 03 Follow-up scheduler | Follow-up sent in the same thread; a **real reply** from the sandbox inbox (LD-0007, Paytm) cancelled the follow-up and set `REPLIED`, with a Telegram hand-off message |
| 01 Telegram intake | Queues real Telegram commands, answers duplicates, and handles Approve / Reject taps |
| 99 Error alerts | Fired for real: a deliberately failing active workflow triggered it 0.1 s later, which messaged Telegram |

## 4. Bugs that testing found (all fixed, all with regression tests)

1. Gemini wrapped its JSON in an array, so a correct answer was read as "no candidates".
2. The pitch invented a personal connection ("as a Gurugram neighbour"). Prompt rule added.
3. Real company sites were pushed out of the top results by aggregator pages, giving false `NOT_FOUND`. Aggregators are excluded up front; one retry without the city.
4. **n8n's Code sandbox has no `URL` class**, so every domain parsed as empty inside n8n while the terminal worked. Replaced with a regex parser; a sandbox test now guards it.
5. `claimLeads(ctx, 0)` treated `0` as the default of 2.
6. A generic executive ("Head - Business Development") was accepted as the contact; fake companies got pitches written for them; guessed emails scored too high. Each tightened.
7. The sandbox inbox was still the example placeholder, so a mail was addressed to a fake address. The mailer now refuses placeholders.

## 5. Verified against real Google (2026-11-15)

| What | Result |
|---|---|
| Google Sheets (service account) | `init_sheet.js` created headers and Config; rows adopted, updated and logged by n8n |
| Gmail send | Mail goes from the sender Gmail to the sandbox inbox only, tagged `[SANDBOX] Intended for ...`; the allow-list blocks any other address |
| Follow-up in the same thread | "Re: ..." landed in the same Gmail thread (Razorpay, Zomato, Ola, Flipkart) |
| Telegram intake inside n8n | A real message was queued by workflow 01; a repeated company was answered "Already have this one" |
| Schedules | 01, 02 and 03 ran on their own schedules after being published |
| Human approval | Ola and Flipkart stopped at `AWAITING_APPROVAL`, were approved from Telegram, then sent about a minute later; Approve / Reject buttons shown on the card |

## 6. NOT yet verified (be upfront about these)

* **Real email delivery to a real lead.** Intentionally never done: every send is locked to two test addresses.
* **Email deliverability of guessed addresses**, which cannot be checked without a paid verifier.
* **Gmail test-mode token** expires after 7 days; re-run `node scripts/gmail_auth.js` if it lapses.
