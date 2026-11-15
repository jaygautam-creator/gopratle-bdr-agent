# Test report

Run on 2026-11-15 against live Gemini, Tavily and Telegram, with a real n8n 2.47 in Docker.

## 1. Automated tests: 72 passing (`make test`, no network, no quota)

| Area | What is checked |
|---|---|
| `lib` | Command parsing (brief's example + variants + junk), de-dupe keys, domain parsing, email extraction, role scoring by company size, candidate and pitch validators, template pitch always valid, prompt-data wrapping, loose JSON parsing |
| Pipeline | Happy path; hallucinated person dropped; array-wrapped LLM JSON; search outage -> `FAILED`; LLM down -> template pitch; 429 falls to the fallback model; weak match -> `NOT_FOUND`; generic exec rejected; aggregator-first results rescued by retry; Serper takes over from Tavily |
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
| 03 Follow-up scheduler | Follow-up sent in the same thread; a simulated reply set `REPLIED` and no follow-up was sent |
| 01 Telegram intake | Executes cleanly and polls the live bot |
| 99 Error alerts | Fired for real: a deliberately failing active workflow triggered it 0.1 s later, which messaged Telegram |

## 4. Bugs that testing found (all fixed, all with regression tests)

1. Gemini wrapped its JSON in an array, so a correct answer was read as "no candidates".
2. The pitch invented a personal connection ("as a Gurugram neighbour"). Prompt rule added.
3. Real company sites were pushed out of the top results by aggregator pages, giving false `NOT_FOUND`. Aggregators are excluded up front; one retry without the city.
4. **n8n's Code sandbox has no `URL` class**, so every domain parsed as empty inside n8n while the terminal worked. Replaced with a regex parser; a sandbox test now guards it.
5. `claimLeads(ctx, 0)` treated `0` as the default of 2.
6. A generic executive ("Head - Business Development") was accepted as the contact; fake companies got pitches written for them; guessed emails scored too high. Each tightened.
7. The sandbox inbox was still the example placeholder, so a mail was addressed to a fake address. The mailer now refuses placeholders.

## 5. NOT yet verified (be upfront about these)

* **Google Sheets and Gmail against the real Google APIs.** Both adapters are tested only against faithful in-memory fakes. They need your Google setup ([setup-google.md](setup-google.md)), then the smoke test in that file.
* **A real inbound Telegram message through workflow 01 inside n8n.** The poll, parse and queue logic is unit-tested, and the poll was exercised live from the local runner, but the n8n run saw no new messages.
* **Workflows 01-03 on their own schedules.** They were executed on demand; scheduling itself was proven only on the error-alert path.
* **Real email delivery.** Until Gmail is connected, mail goes to the dry-run outbox and is previewed in Telegram.
* **Email deliverability of guessed addresses**, which cannot be checked without a paid verifier.
