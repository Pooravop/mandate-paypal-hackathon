# Devpost submission copy

Paste-ready text for the submission form. Trim to taste.

---

## Project name

**Mandate — a payment control plane that lets AI agents spend real money safely**

## Elevator pitch (one line)

Agents get a budget with rules, not a card number: every spend clears a deterministic policy engine and an AI intent adjudicator before PayPal moves anything, and the whole decision trail is hash-chained.

---

## What it does

If you want an AI agent to buy things for you, today you pick between handing it a card number and hoping, or approving every purchase yourself and losing the point of automation. Mandate is the missing layer in between.

You grant an agent a **mandate**: a budget, hard limits (per-transaction cap, velocity, merchant and category rules, expiry), and a stated **purpose** in plain English. The agent can then transact on its own — but every spend it attempts passes two gates before PayPal moves money:

**Stage 1 — the policy engine.** Sixteen deterministic rules, enforced by code that cannot be talked out of its position by a persuasive prompt. Budget, caps, velocity, allowlists, expiry, revocation, suspected duplicates. Each rule returns machine-readable evidence, so the UI and the model see identical facts. A hard failure here is terminal: the model is never even consulted.

**Stage 2 — the AI intent adjudicator.** This exists to catch the one class of problem rules cannot see: a purchase that is technically within every limit but has nothing to do with what the mandate was for. An agent funded for cloud infrastructure trying to buy a $485 office chair breaks no rule — and is denied here.

What survives both gates settles through PayPal on one of two rails:

- **Fully autonomous** → **PayPal Payouts v1**, server-to-server, no human present, no browser redirect.
- **Needs a human** → **PayPal Orders v2 with `intent=AUTHORIZE`**. We don't treat a click in our own UI as consent: the control plane creates a real PayPal order and hands the reviewer PayPal's own approval URL. They authenticate with PayPal and authorise the hold there, then the control plane captures via Payments v2.

Every state change is appended to a SHA-256 hash-chained, append-only event log. Mandates and spend requests are projections replayed from it, so the audit trail *is* the state rather than a log of it. Change one byte of `data/events.jsonl` and `GET /api/ledger/verify` names the exact event that was altered.

The same gate is exposed as an **MCP server**, so any external agent — Claude Desktop, Claude Code, your own — gets exactly four tools (`get_mandate`, `search_catalog`, `request_spend`, `get_spend_request`) and no PayPal credentials. That is the security argument: you don't have to trust the agent, its prompt, or whatever it read on the internet. You only have to trust the mandate you wrote.

### Two properties that make it more than a wrapper

**The AI can only tighten a decision, never loosen one.** It can downgrade `APPROVE` to `ESCALATE` or `DENY`. It can never overturn a hard rule, and rules that demand a human survive an enthusiastic model approval. The adjudicator also **fails closed**: any model error, timeout or malformed response yields `ESCALATE`, never `APPROVE`.

**Agent-written text is treated as untrusted data.** The description and justification were written by the very agent whose spending is being policed. They are fenced in the adjudicator prompt, and instruction-like content there is flagged as `PROMPT_INJECTION_ATTEMPT` and denied.

---

## How we built it

TypeScript throughout. Node + Express API, React + Tailwind control-plane UI with live SSE updates, no database — the event log is the store.

Chosen deliberately:

- **Money is integer minor units everywhere.** Floats appear only at the PayPal boundary, which requires a decimal string. A budget system that loses a cent to rounding is a broken budget system.
- **Reservations with a synchronous commit point.** Funds are reserved on approval and converted to spent only when PayPal confirms. The budget is re-validated immediately before the reservation is written, with no `await` in between, so concurrent requests cannot interleave. Without it, three $84 requests each pass an isolated budget check and collectively overspend a $200 mandate — there's a test for exactly that.
- **Expiry evaluated at read time**, not by a sweeper job, so an expired mandate is inert even if nothing else is running.
- **A single-writer lock on the ledger.** A hash chain has one valid writer; two processes appending would fork it. The second writer is refused with an explanation rather than silently corrupting the chain.

68 tests, no network and no credentials required.

## Challenges we ran into

**Orders v2 can't do autonomous payment.** It requires a buyer to approve in a browser — correct for human checkout, fatal for an agent under a standing mandate. That pushed us to Payouts v1 for the autonomous rail and left Orders v2 doing what it's genuinely good at: real human consent, with authorize-then-capture so a hold can be voided for free if the agent turns out to have been wrong.

**A currency-field asymmetry that fails silently.** Payouts v1 amounts use `{"currency": "USD"}`; Orders v2 and Payments v2 use `{"currency_code": "USD"}`. Getting it wrong is a bare `400`. There's now a dedicated helper for each and a test asserting they stay different.

**Webhook signature verification is easy to break invisibly.** `webhook_event` must be the exact signed bytes. Running the body through `express.json()` and re-serialising it shifts key order and the signature silently stops matching. The route is mounted with `express.raw()` and the verification payload is assembled with the raw body spliced in verbatim.

**A real race condition.** Our first implementation reserved funds *after* awaiting the AI adjudicator, so concurrent requests all evaluated the same balance. A test caught three payments settling against a budget that fit two.

## What we learned

The interesting problem in agentic commerce isn't getting a model to call a payments API — that part is easy. It's building the authority boundary around it: what the agent is allowed to do, who decides when it's unclear, and how you prove afterwards what was permitted. An LLM should never be the only thing between an agent and your balance, but rules alone can't encode "is this what I actually meant?" You need both, in that order.

## What's next

Vault-backed card rails for merchants without PayPal accounts; mandate delegation so an orchestrator can sub-grant narrower budgets to workers; learned policy suggestions from historical approvals; and the same event model on Postgres with an append-only constraint for multi-node deployments.

---

## Tools used

| Tool | How it was used |
|---|---|
| **PayPal Payouts API v1** | The autonomous settlement rail. `POST /v1/payments/payouts` moves funds server-to-server with no redirect, which is what makes headless agent payment possible. Spend-request id reused as `sender_batch_id` + `PayPal-Request-Id` for double-spend safety. |
| **PayPal Orders API v2** | The human-in-the-loop rail. `POST /v2/checkout/orders` with `intent=AUTHORIZE` and `payment_source.paypal.experience_context`, surfacing PayPal's real `approve` link so consent happens at PayPal. |
| **PayPal Payments API v2** | `authorizations/{id}/capture`, `authorizations/{id}/void`, `captures/{id}/refund` — capture after human approval, free void when an escalation is denied, refunds. |
| **PayPal Webhooks** | `POST /v1/notifications/verify-webhook-signature`. Events are signature-verified over raw bytes before being acted on; unverifiable ones are recorded for forensics but never cause a state change. |
| **PayPal OAuth2** | Client-credentials token with caching, in-flight request sharing, and `debug_id` preserved on every failure. |
| **Anthropic Claude (`claude-sonnet-5-5`)** | Two roles: the **intent adjudicator** (single-shot, strict JSON, schema-validated, fails closed) and the **procurement agent** (multi-turn tool-use loop). |
| **Model Context Protocol (MCP)** | `@modelcontextprotocol/sdk` stdio server exposing the mandate-gated tools, so any external agent can spend under a mandate without holding credentials. |
| **TypeScript · Node · Express · Zod** | API, validation at the trust boundary, strict typing throughout. |
| **React · Vite · Tailwind CSS v4** | Control-plane UI with live SSE streaming of ledger events and agent reasoning. |
| **Node crypto (SHA-256) · `node:test`** | Hash-chained audit ledger; 68 hermetic tests. |

Provider-agnostic AI: Anthropic by default, any OpenAI-compatible endpoint via `OPENAI_BASE_URL`, or a deterministic built-in reasoner so the project runs end-to-end with no API key at all.

---

## Try it

```bash
npm install
npm run demo -- --reset   # full walkthrough, no credentials needed
npm run dev               # the real thing, UI on :5173
npm run doctor            # checks your PayPal + AI setup and says what to fix
```

With no credentials it runs against a local PayPal simulator and a deterministic reasoner, and says so plainly in the UI — nothing silently pretends to be real.
