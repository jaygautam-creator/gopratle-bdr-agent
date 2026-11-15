# Failure modes and how each is handled

Rows are covered by automated tests (`make test`) and/or were observed live; those observed live are marked *(live)*. See [test-report.md](test-report.md).

| Scenario | Handling |
|---|---|
| Gemini rate limit (429) on the main model | Fall through to the next model, which has its own quota bucket |
| Gemini 5xx / unparseable JSON / array-wrapped JSON | One retry, unwrap, then next model |
| All Gemini models down | Template pitch; the lead is flagged as such. Without the LLM there is no verified contact, so it is not auto-sent |
| Pitch is not exactly 3 lines, has `[Name]` placeholders, or does not mention the company | Rejected, retried once, then template |
| Model invents a person | Dropped: the name must appear in the fetched text and the source URL must be one we fetched |
| Candidate is a generic exec (not Founder/HR/Events) | Not accepted as the contact |
| Instructions hidden in a web page | Page text is passed as marked data; output must be strict JSON; mail only goes to the sandbox inbox |
| Tavily quota exhausted or down | Serper fallback; if both fail the lead retries, then `FAILED` with a clear error |
| Aggregator sites crowd out the real website | Excluded up front; retry once without the city |
| Company does not exist | `NOT_FOUND` (weak domain match and nobody found); nothing is sent *(live: "Xqzvbnm Holdings")* |
| Ambiguous / global company | No qualifying contact -> `NEEDS_REVIEW` *(live: "Apple, Gurgaon")* |
| Hunter missing or out of credits | Website email -> role inbox -> MX-verified guess, labelled `guessed` |
| Only a generic inbox exists | Used and labelled `role_inbox` |
| Run crashes mid-lead | Row stuck in `PROCESSING` > 15 min is reset to `NEW`; after 3 attempts `FAILED` |
| Two runs overlap | n8n is configured to run production executions one at a time (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`), so scheduled runs queue; claimed rows are also marked `PROCESSING` before work starts; max 2 leads per run. Not safe if you raise that limit while using the Sheets backend (the claim is not atomic across runs) |
| Same company+city requested twice | Telegram: answered with the existing result. Sheet: second row marked `DUPLICATE` |
| Telegram message handled but offset not saved (crash) | Offset is committed after handling: a crash re-delivers, never loses |
| Stranger finds the bot | Not on the allow-list: refused, logged, nothing queued |
| Unparseable message | Regex first, then LLM parse that must quote values literally present in the text; else help text |
| Gmail credentials revoked | Send fails with a clear error naming the credential; the lead stays `READY_TO_SEND` (with the error in the row) and is retried every run once fixed; the requester sees 'Send failed' |
| Sheets credentials revoked / Sheets API down | The node errors, so the error workflow alerts the admin on Telegram; nothing is lost because no state was changed |
| Nobody answers an approval request | The lead stays `AWAITING_APPROVAL` indefinitely; it never times out into a send. `/status LD-x` shows it again |
| Approve tapped twice, or from a stranger's chat | Second tap reports "not waiting for approval"; non-allow-listed chats are refused; nothing changes |
| Gmail send fails | Row stays `READY_TO_SEND`; retried next run without re-spending Tavily/Gemini |
| Reply check fails | No follow-up is sent (never follow up blindly); retried next run |
| Lead replied before the follow-up | `REPLIED`, follow-up cancelled, human notified |
| Placeholder or missing sandbox inbox | Send refused with an explanation *(live)* |
| Real send attempted without both flags | Redirected to the sandbox inbox anyway |
| A workflow node errors | Error workflow sends the workflow, node and message to the admin chat *(live)* |
| Hand-edited Sheet columns / extra columns / reordered header | Columns are located by header name; untouched cells are never overwritten |
| n8n Code sandbox lacks `URL`, `fetch` | Code avoids them; a vm-sandbox test enforces it *(this caught a real bug)* |

Not handled, by design: phone numbers; validating that a guessed email is deliverable (needs a paid verifier); multi-user permissions.
