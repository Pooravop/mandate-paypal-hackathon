# Demo video script (under 3 minutes)

Judges aren't required to watch past 3:00, so the payoff has to land early. The structure below puts the strongest moment — an AI denial that no rule would have caught — at about 1:20.

## Before you record

```bash
cp .env.example .env          # add sandbox credentials + ANTHROPIC_API_KEY
npm run doctor                # everything should be OK, no FAIL
npm run build
npm start                     # single process on :8787
```

Then, in the UI: **Seed demo mandate**. Leave the ledger otherwise empty so the audit trail is short and readable on camera.

Record at 1920×1080. Zoom the browser to ~110% — the UI is dense and small text does not survive video compression.

Have ready in a second tab: your sandbox buyer login, and `data/events.jsonl` open in an editor for the tamper moment.

---

## 0:00 – 0:20 — The problem

> "If you want an AI agent to buy things for you, you have two options today. Hand it a card number and hope. Or approve every purchase yourself, and lose the point of automation.
>
> This is Mandate. Agents get a budget with rules, not a card number."

*On screen:* the dashboard. Point at the posture badges — "PayPal: live sandbox API", "AI: claude-sonnet-5-5". Say it out loud: **this is real money moving in the PayPal sandbox, and a real model reasoning about it.**

## 0:20 – 0:40 — The mandate

*On screen:* expand the mandate card.

> "I've granted this agent two thousand dollars for thirty days. Six hundred max per transaction. Anything at or above two-fifty needs me to approve it. And a purpose, in plain English: keep the production data pipeline running.
>
> That purpose is not decoration. It's what the AI holds every single purchase against."

## 0:40 – 1:05 — Autonomous settlement

*On screen:* Agent console. Send: **"Ingest volume is up. Add another standard compute node and a terabyte of object storage."**

Let the tool calls stream. Then open the decision trail.

> "The agent searched the catalog and submitted a spend. Sixteen deterministic rules passed. The AI confirmed it serves the mandate's purpose. A hundred and seven dollars, settled through PayPal Payouts — server to server, no browser, no human. That's the autonomous rail."

*Point at the PayPal payout batch id.*

## 1:05 – 1:30 — The moment that matters

*On screen:* send **"Order an ergonomic task chair for the new backend hire starting Monday."**

> "Now watch this. Four hundred and eighty-five dollars. Under the six hundred cap. Inside the budget. The merchant isn't blocked, the category isn't blocked. **Every hard rule passes.**"

*Open the trail. Let the viewer see the green checkmarks, then the red DENY.*

> "And it's denied — by the AI, on intent. A chair is not a data pipeline. No rule you could write would have caught that, because there's nothing wrong with it except that it isn't what the money was for."

**Pause here.** This is the thesis of the project; give it a beat.

## 1:30 – 2:05 — Escalation through real PayPal consent

*On screen:* send **"We need 50,000 company enrichment lookups to backfill the customer dimension table."**

> "Two hundred and fifty dollars. In-purpose, the AI approves it — but it's at my approval ceiling, so the AI's approval isn't enough. It escalates."

*Go to Approvals. Click Approve.*

> "And approving here does not pay anyone. The control plane creates a real PayPal order and hands me PayPal's own approval URL."

*Click through to PayPal, log in as the sandbox buyer, approve.*

> "I authenticate with PayPal. I authorise the hold there. Then the control plane captures it."

*Land back on the capture confirmation. Show authorization id and capture id.*

## 2:05 – 2:25 — Blocked by code

*On screen:* send **"Buy the 500-unit gift card bundle as a team reward."**

> "Twenty-five hundred dollars. Over the cap, over the budget, denylisted category, over the velocity limit. Denied by code — and notice the AI was never consulted. A hard rule is terminal. The model doesn't get a vote, so it can't be talked into one."

## 2:25 – 2:50 — The audit chain

*On screen:* Audit ledger tab.

> "Every decision is one append-only, hash-chained event. Mandates and balances aren't stored anywhere — they're replayed from this log. The audit trail *is* the state."

*Switch to the editor. Change one word in a denial event's summary. Save. Back to the UI, click **Verify chain**.*

> "Change one byte, and it names the exact event that was altered."

*Red BROKEN badge on screen.*

## 2:50 – 3:00 — Bring your own agent

> "And the same gate is an MCP server. Point Claude Desktop at it and your agent gets four tools and no credentials. You don't have to trust the agent. You only have to trust the mandate."

---

## If you have to cut

Drop **2:05 – 2:25** (blocked by code) first — it's the least surprising outcome. Then shorten the setup at 0:20.

Never cut the 1:05 AI denial or the 2:25 tamper check. Those two are the whole submission.

## Don't

- Don't read the rule names aloud; they're on screen.
- Don't narrate what you're clicking. Say what it *means*.
- Don't apologise for the synthetic catalog. The merchants are scenery; the payments are real, and saying so once is enough.
- Don't use copyrighted music. The rules prohibit it.
