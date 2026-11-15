# Design decisions

| Decision | Why | Trade-off |
|---|---|---|
| **n8n, with logic in tested modules** | The brief names n8n; visual workflows demo well. Putting logic in `src/` makes it unit-testable and reviewable instead of buried in 30 nodes | Each Code node embeds a ~50 KB bundle, so the workflow JSON is large. It is generated, never hand-edited |
| **Gemini reads and writes; it does not search** | Grounded search is not reliably free. Our workflow searches (Tavily), so every fact has a source URL we can check | One more provider to depend on (with a Serper fallback) |
| **Verify LLM output in code** | An LLM will happily invent a plausible name. A person is accepted only if their name appears in the fetched text | Occasionally drops a real person the model paraphrased |
| **Sheet `status` column is the queue** | One code path for Telegram and Sheet triggers; survives restarts; no 'new row' trigger loops or lost rows | Up to ~1 minute latency (the bot confirms instantly) |
| **Scan for due follow-ups instead of `Wait` nodes** | A Wait node holds an execution open for days and cannot see replies | Needs a scheduler workflow |
| **Telegram polling, not webhook** | No public URL, tunnel or HTTPS needed; works on a laptop | ~20 s latency, fine for this use |
| **Ports and adapters (store, mail)** | Lets everything run and be tested before Google is configured; flipping an env var switches to Sheets/Gmail | Two backends to keep in sync (a test pins the shared contract) |
| **Sandbox enforced in the mailer** | A workflow edit or typo can never email a real lead | Real sending needs two explicit settings |
| **Telegram sent from Code nodes, not HTTP nodes** | An HTTP node shows the bot token in its URL in n8n's execution view (and in screen recordings) | Less 'visual' than a Telegram node |
| **No n8n credentials; secrets come from `.env`** | The exported workflow JSON is portable and contains no secrets | Secrets must be passed to the container |
| **Free-tier model chain** | Verified on this account: full Flash models allow only 20 requests/day; Flash-Lite models allow 500/day each | Lite models are slightly less capable; output is validated |
| **LinkedIn via search snippets only** | Scraping or logging in violates LinkedIn's terms and is fragile | Less data per profile |

## Rejected alternatives

* **A fully autonomous agent loop** (the LLM picks every step): slower, costlier, unpredictable, and it can fail live on camera. A bounded pipeline with one LLM step per decision is easier to explain and test.
* **n8n Google Sheets Trigger**: needs OAuth that expires in testing mode and can re-fire on our own write-backs.
* **Make.com**: tight free-tier operation limits and weaker custom logic.
* **WhatsApp**: needs Meta business verification or a paid provider.
