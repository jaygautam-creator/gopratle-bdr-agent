# Reply to the GoPratle team (draft)

Subject: Re: Jay and GoPratle - BDR Lead Enrichment & Outreach Agent

Hi Amit,

Thanks for the task. Here is my build:

* **Screen recording:** <link>
* **GitHub (workflow JSON, code, docs):** <link>

What it does: a Telegram command ("Find event leads for Zomato in Gurgaon") or a Company + City row in a Google Sheet queues a lead. An n8n workflow finds the Founder/HR/Events contact (Tavily search + Gemini, every contact verified against its source text), finds an email, writes a tailored 3-line GoPratle pitch, logs everything back to the Sheet, then waits for my approval (Approve / Reject buttons in Telegram) before sending the outreach (sandbox inbox), and sends a follow-up in the same thread, which is cancelled automatically if the lead replies.

Stack: n8n (self-hosted), Gemini free tier, Tavily, Telegram, Google Sheets, Gmail. All free tier.

Worth knowing: emails are mostly pattern guesses and are labelled as such with a confidence score; sandbox mode is on by default and enforced in code. The README lists the limitations and the failure modes I handled.

Happy to walk through any of it.

Jay
