# Mandate

**A payment control plane that lets AI agents spend real money safely.**

Built for the PayPal AI Hackathon. Agents get a budget with rules, not a card number.

---

## The problem

If you want an AI agent to buy things for you, today you have two options: hand it a card number and hope, or approve every purchase yourself and lose the point of automation. Neither scales. The missing piece is not a better model — it is the infrastructure in between.

Giving an agent a payment credential is giving it unbounded authority. A prompt-injected agent, a confused agent, or a correct agent acting on bad data all spend the same money. And after the fact there is no way to prove what the agent was *allowed* to do, only what it did.

## What Mandate does

You grant an agent a **mandate**: a budget, hard limits, and a stated purpose. Every spend the agent attempts passes through two gates before PayPal moves anything.

```
  human ──grants──► ┌──────────────────────────────────────────┐
                    │ MANDATE                                   │
                    │ $2,000 / 30 days                          │
                    │ cap $600 per transaction                  │
                    │ autonomous below $250                     │
                    │ purpose: "keep the production data        │
                    │ pipeline running: compute, databases,     │
                    │ storage, monitoring, data APIs"           │
                    └──────────────────────┬───────────────────┘
                                           │
   agent ──request_spend──────────────────►│
   (holds no PayPal credentials)           │
                                           ▼
            ┌───────── STAGE 1: POLICY ENGINE (deterministic) ─────────┐
            │  budget · per-tx cap · velocity · merchant allowlist     │
            │  category rules · expiry · revocation · duplicates       │
            │  16 rules, each with machine-readable evidence           │
            └──────────────────────────┬──────────────────────────────┘
                              FAIL ────┴──── pass/flag
                                │                │
                             DENIED              ▼
                        (model never    ┌─ STAGE 2: AI ADJUDICATOR ─┐
                         consulted)     │ "does this purchase       │
                                        │  actually serve the       │
                                        │  mandate's purpose?"      │
                                        └────────────┬──────────────┘
                                                     │
                      ┌──────────────────────────────┼─────────────────────┐
                      ▼                              ▼                     ▼
                  APPROVE                       ESCALATE                 DENY
                      │                              │                     │
            PayPal Payouts v1            PayPal Orders v2            blocked
            server-to-server              intent=AUTHORIZE
            no human present              → real PayPal approval URL
                      │                   → Payments v2 capture
                      │                              │
                      └────────────┬─────────────────┘
                                   ▼
                    hash-chained, append-only audit ledger
```

Two properties make this more than a wrapper:

**The AI cannot loosen a decision, only tighten it.** Hard limits are enforced by code that cannot be argued with by a persuasive prompt. A deterministic `FAIL` is terminal — the model is never even consulted. The model exists to catch the one class of problem rules cannot see: a purchase that is technically within every limit but has nothing to do with what the mandate was for. It can downgrade `APPROVE` to `ESCALATE` or `DENY`; it can never upgrade anything.

**The audit trail is the state, not a log of it.** Every mandate and spend request is a projection replayed from an append-only, SHA-256 hash-chained event log. Change one byte of `data/events.jsonl` and `GET /api/ledger/verify` names the exact event that was altered.

## See it in 60 seconds

```bash
git clone <this-repo> && cd mandate
npm install
npm run demo -- --reset
```

No credentials needed. That prints a full walkthrough of the four outcomes the system exists to distinguish:

| Scenario | Amount | What happens |
|---|---|---|
| Compute node + object storage | $107 | Clears all 16 rules, AI confirms it serves the purpose → **settles autonomously via PayPal Payouts** |
| 50k company enrichment lookups | $250 | In-purpose, but at the autonomous ceiling → **escalates to a human**, who is handed a real PayPal approval URL |
| Ergonomic task chair | $485 | Breaks *no* hard rule, but is outside the mandate purpose → **denied by the AI adjudicator** |
| 500-unit gift card bundle | $2,500 | Breaches cap, budget, category denylist and velocity → **denied by code; the model is never consulted** |

Then it resolves the escalation the whole way through authorize → capture, prints the mandate's closing position, and verifies the hash chain.

## Run the full app

```bash
npm install
npm run dev          # API on :8787, UI on :5173
```

Open <http://localhost:5173>, click **Seed demo mandate**, and brief the agent in the console. The UI states plainly at all times whether PayPal calls and model calls are real or simulated — nothing silently pretends.

For a single-process deployment:

```bash
npm run build && npm start   # everything on :8787
```

### Making it real

```bash
cp .env.example .env         # then fill in credentials
npm run doctor               # verifies every value and tells you what to fix
```

`npm run doctor` authenticates against PayPal, reports the granted scopes, creates and abandons a throwaway order to prove the Orders rail works, checks your payout receiver, pings your model, and verifies the audit chain. It tells you exactly what to do about each failure.

Minimum for real sandbox money movement:

1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) — type **Merchant**, attached to your sandbox business account. Put the client id and secret in `.env`.
2. Set `PAYPAL_PAYOUT_RECEIVER` to a sandbox **personal** account email from [your sandbox accounts](https://developer.paypal.com/dashboard/accounts). Without this, merchants point at a placeholder and payouts fail.
3. Optionally set `ANTHROPIC_API_KEY` for real model reasoning instead of the built-in reasoner.

Everything degrades honestly. No PayPal credentials → payments are simulated locally and tagged `SIMULATED` everywhere. No model key → a deterministic lexical reasoner adjudicates and says so. The app never silently fakes a capability.

## Bring your own agent (MCP)

The same gate is exposed as an MCP server, so this is infrastructure rather than a demo app. Point Claude Desktop, Claude Code, or any MCP client at it:

```json
{
  "mcpServers": {
    "mandate": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mandate/server/src/mcp/stdio.ts"],
      "env": {
        "MANDATE_ID": "mdt_...",
        "PAYPAL_CLIENT_ID": "...",
        "PAYPAL_CLIENT_SECRET": "...",
        "PAYPAL_PAYOUT_RECEIVER": "sb-buyer@personal.example.com"
      }
    }
  }
}
```

The agent gets exactly four tools — `get_mandate`, `search_catalog`, `request_spend`, `get_spend_request` — and nothing else. It never sees a PayPal credential. Every `request_spend` goes through the identical policy and adjudication pipeline the HTTP API uses.

That is the security argument: **you do not have to trust the agent, its prompt, or whatever it read on the internet. You only have to trust the mandate you wrote.**

## PayPal integration

Two rails, chosen deliberately, because agentic payment and human checkout are different problems.

**Payouts v1** — `POST /v1/payments/payouts`. The autonomous rail. Orders v2 requires a buyer to approve in a browser, which is correct for human checkout and fatal for an agent acting under a standing mandate. Payouts moves funds server-to-server with no redirect, which is what makes headless agent settlement possible at all. The spend-request id is used as both `sender_batch_id` and `PayPal-Request-Id`, so a retry after a crash cannot pay a merchant twice.

**Orders v2 + Payments v2** — `POST /v2/checkout/orders` with `intent=AUTHORIZE`, then `POST /v2/payments/authorizations/{id}/capture`. The human-in-the-loop rail. When a spend escalates, approving it in our UI is not treated as consent: the control plane creates a real PayPal order and hands the human PayPal's own approval URL. They authenticate with PayPal and authorise the hold there. Authorize-then-capture is the right shape here — a hold can sit for up to 29 days and be voided for free if the agent turns out to have been wrong, rather than needing a refund after the fact. Refunds go through `POST /v2/payments/captures/{id}/refund`.

**Webhooks** — `POST /v1/notifications/verify-webhook-signature`. Received events are signature-verified before they are acted on; unverifiable ones are still recorded for forensics but never cause a state change. The route is mounted with `express.raw()` because verification needs the exact signed bytes — running the body through a JSON parser and re-serialising it shifts key order and silently breaks the signature.

> One API asymmetry worth knowing, because it produces a silent `400`: Payouts v1 amounts use `{"currency": "USD"}` while Orders v2 and Payments v2 use `{"currency_code": "USD"}`. `server/src/util/money.ts` has a dedicated helper for each and a test asserting they stay different.

## AI integration

| Role | What it does | Why |
|---|---|---|
| **Intent adjudicator** | Single-shot, strict-JSON judgement on whether a spend serves the mandate's purpose | Rules cannot encode "is this what I meant?" |
| **Procurement agent** | Multi-turn tool-using loop: reads its mandate, searches the catalog, submits spends | The thing being governed |

Provider-agnostic: Anthropic (default, `claude-sonnet-5-5`), any OpenAI-compatible endpoint, or a deterministic built-in reasoner when no key is set.

Three deliberate choices in the adjudicator:

- **It fails closed.** Any model error, timeout, malformed response or schema violation yields `ESCALATE`, never `APPROVE`. An AI layer whose outage opens the gates would be worse than no AI layer.
- **Agent text is untrusted data.** The description and justification were written by the very agent whose spending is being policed. They are fenced in the prompt and the model is instructed to treat instruction-like content there as a manipulation attempt, deny, and flag `PROMPT_INJECTION_ATTEMPT`.
- **Output is schema-validated.** Responses are parsed with a brace-matching JSON extractor and validated with Zod before anything acts on them.

## Architecture

```
server/src/
  config.ts              posture resolution; states honestly what is real
  catalog.ts             synthetic marketplace the agent shops in
  types.ts               domain model (all amounts in integer minor units)
  policy/engine.ts       16 deterministic rules + the one-way combine ratchet
  ai/
    adjudicator.ts       intent judgement, fails closed, injection-aware
    agent.ts             tool-using procurement agent
    provider.ts          normalised LLM interface + robust JSON extraction
    anthropic.ts  openai.ts  heuristics.ts
  paypal/
    client.ts            OAuth token cache, idempotency, debug_id preservation
    payouts.ts           autonomous rail
    orders.ts            human-approval rail
    webhooks.ts          signature verification over raw bytes
    simulator.ts         local stand-in, everything tagged simulated
  ledger/
    ledger.ts            event-sourced store, hash chain, single-writer lock
    hash.ts              canonical serialisation (key-order independent)
  service/
    spend.ts             the pipeline, reservations, settlement, refunds
    mandates.ts          grant / update / revoke, read-time expiry
  mcp/stdio.ts           bring-your-own-agent boundary
  cli/doctor.ts  cli/demo.ts
web/src/                 React + Tailwind control-plane UI, live SSE updates
```

Design decisions worth calling out:

**Money is integer minor units everywhere.** Floats appear only at the PayPal boundary, where the API requires a decimal string. A budget system that loses a cent to rounding is a broken budget system.

**Reservations, not optimistic checks.** Funds are reserved the moment a request is approved or escalated, and only converted to spent when PayPal confirms. The budget is re-validated at a synchronous commit point immediately before the reservation is written — there is no `await` between reading the balance and writing the reservation, so concurrent requests cannot interleave. Without this, three $84 requests each pass an isolated budget check and collectively overspend a $200 mandate. There is a test for exactly that.

**Expiry is evaluated at read time.** A cron job that marks mandates expired is a liveness dependency: if it dies, expired mandates keep authorising spend. Deriving it from the clock on every read means an expired mandate is inert even if nothing else is running.

**The ledger takes a single-writer lock.** A hash chain has exactly one valid writer. Two processes with the same log open keep separate in-memory tails and interleave into two divergent chains. Running `npm run dev` and `npm run demo` at once would do it, so the second writer is refused with an explanation instead of silently corrupting the chain.

## Tests

```bash
npm test     # 68 tests, no network, no credentials
```

Covering minor-unit arithmetic and the Payouts/Orders currency-field asymmetry; hash-chain integrity including altered, deleted and re-signed events; projection replay; all 16 policy rules; the one-way AI ratchet; and the full pipeline end to end — autonomous settlement, AI denial, escalation through capture, concurrent overspend, revocation mid-queue, double-decision rejection, refunds, and the complete audit sequence.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Current posture: is PayPal live, is the AI real |
| `POST /api/mandates` · `GET /api/mandates` | Grant and list mandates |
| `POST /api/mandates/:id/revoke` | Kill switch, immediate |
| `POST /api/requests` | **Submit a spend** — the endpoint an external agent calls |
| `POST /api/requests/:id/decision` | Resolve an escalation |
| `POST /api/requests/:id/refund` | Refund a captured payment |
| `GET /api/ledger` · `GET /api/ledger/verify` | Read and verify the audit chain |
| `GET /api/events` | SSE stream of ledger events |
| `POST /api/agent/chat` | SSE stream of agent reasoning and tool calls |
| `POST /api/paypal/webhook` | Signature-verified PayPal webhooks |

## Limitations

Stated plainly rather than hidden:

- **Payouts cannot be refunded through the API.** PayPal has no refund endpoint for a completed payout. The control plane says so explicitly instead of pretending to reverse it; reversibility is a reason to route a spend through the Orders rail.
- **The catalog is synthetic.** Merchants are scenery; the payments are real. Every merchant settles to one sandbox account by default because sandbox tenants normally have only one or two test accounts.
- **The event log is a file, not a database.** Right for a hash-chained audit trail at this scale and it makes tamper-evidence inspectable with `cat`, but it is single-node. A production deployment would want the same event model on Postgres with an append-only constraint.
- **The built-in reasoner is lexical, not semantic.** With no model key, intent matching is vocabulary overlap. It reliably catches the blunt failure (infrastructure budget buying furniture) and is honest about being a fallback.
- **Mandate revocation does not claw back settled payments.** It stops all future authorisation immediately; already-captured money needs a refund.

## License

MIT — see [LICENSE](LICENSE).
