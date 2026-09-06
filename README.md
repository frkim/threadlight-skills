# Threadlight — Pilot Pipeline Skills

**Turn a business-process idea into a governed working pilot, with an
evidence-backed path to production.**

Threadlight helps you specify, build, deploy, and assess an AI agent for a real
business workflow: triaging returns, reviewing claims, or handling approval
requests. The goal is a working pilot **and evidence of what works, what it
costs, and what still needs attention** before production.

This repository is a **toolkit for an AI coding assistant**, not a standalone
chatbot or an agent runtime. It packages **22 pipeline skills plus one
agent-guided lifecycle planner (23 total)**. Each skill supplies instructions
and, where needed, scripts, templates, and reference material. The assistant
uses them to create and assess a separate pilot project.

**Who it is for:** solution engineers, internal platform teams, and partners
building enterprise AI pilots. Sellers can use the qualification and design
skills to explore a use case before involving a deployment engineer.

[How it works](#pipeline-flow) · [Get started](#get-started) ·
[Skill catalog](#skill-catalog) · [Technical briefing](THREADLIGHT.md)

## Pipeline flow

Threadlight is **specification-first**. The business rules and success criteria
are written down before the implementation is derived from them.

| Step | What happens | What you get |
|---|---|---|
| **1. Qualify** | Capture the workload, expected volume, and potential value. No repository or Azure access is required. | Sizing, discovery notes, and an optional ROI estimate. |
| **2. Design** | Define the process, business rules, data, tools, governance, and technical foundation. | A durable `specs/SPEC.md`, agent instructions, and demo or pilot materials. |
| **3. Build and deploy** | Generate sample data, iterate locally, and deploy to an Azure pilot environment, including Microsoft Foundry hosting. | Agent code, infrastructure, and a running endpoint. |
| **4. Gather evidence** | Check the deployment, invoke scenarios, assess quality and safety, and record governance and cost evidence. | Machine-readable manifests and human-readable reports. |
| **5. Review and hand off** | Assess production gaps and prepare customer-specific delivery and onboarding guidance. | An advisory readiness scorecard and optional CI/CD pipelines and runbooks. |
| **6. Improve** | Learn from completed runs, compare cost and quality, and plan dependency or runtime upgrades. | Recommendations for the next iteration, not automatic production changes. |

These are lifecycle steps, not one unconditional script. You can invoke an
individual skill or use `threadlight-auto` to guide the pilot path. Supporting
features such as human approvals, an operator workspace, and event triggers are
added when the use case needs them.

### How the skills share context

**Files are the contracts between stages.** Each stage reads the specification
and relevant evidence produced by earlier stages.

| Artifact in the pilot project | Purpose |
|---|---|
| `specs/SPEC.md` | The business process, requirements, tool contracts, and success criteria. |
| `specs/foundation.md` and `specs/manifest.json` | Technical decisions and the machine-readable deployment contract. |
| `AGENTS.md` and `src/agent/skills/` | Agent instructions and workflow-specific skills derived from the specification. |
| `specs/*-manifest.json`, `tests/*-manifest.json`, and reports | Evidence of completed assessments, including missing or unverified controls. |
| `.threadlight/auto-state.json` | Saved lifecycle state used when resuming the guided pilot path. |

The Python [orchestrator](skills/threadlight-auto/references/orchestrator.py)
reads state and checks artifact freshness to decide which stages to run, skip,
or rerun. **The planner decides; the coding assistant executes the skills.**
A changed specification or stale evidence can cause downstream stages to rerun.

### Canonical lifecycle classification

| Execution mode | Skills or work | Boundary |
|---|---|---|
| No-repo entry | `qualify` | Declared inputs only; no Azure access or deployed runtime. |
| Agent-guided pilot path | `design`, optional `local-test`, `deploy`, `safe-check`, cost forecast, live invocation, `evals`, `redteam`, `govern` | Auto plans; the coding assistant executes. Deployment and live calls require Azure access and incur costs. |
| Explicit evidence handoffs | `connect`, `ground`, `loadtest`, `governed-actions` | Auto does not execute these skills. Ground assesses supplied evidence; load testing is live and budget-capped; governed-actions is manually invoked and read-only by default. |
| Optional readiness review | `production-ready` | Advisory assessment, not certification or automatic remediation. |
| Production handoffs | `cicd`, `customize` | Human-led pipeline setup and customer onboarding, outside Auto. |
| Later-pilot value evidence | Settled actuals and reconciliation | Real cost and outcome measurements arrive after usage. |
| Offline improvement | `router-bench`, `upgrade` | Finished-run learning and plan-only compatibility scans, outside Auto. |

The optional [Threadlight Lifecycle Canvas](.github/extensions/threadlight-lifecycle/README.md)
adds a progress panel in GitHub Copilot App. It reads pilot artifacts and sends
validated next-action requests back to chat; it does not execute stages or
Azure operations directly. CLI and other skill-based workflows do not require it.

## What "working" and "ready" mean

**A working pilot is not automatically production-ready.** Assessments use
recorded evidence, including its freshness, rather than just checking whether
a control was declared. Missing evidence stays unverified.

The paid live workflow distinguishes two outcomes:

| Outcome | What it establishes |
|---|---|
| **Live smoke** | Design, deployment, invocation, and assurance producers executed. It does **not** establish production readiness. |
| **Readiness proof** | Also requires a green post-deploy safe-check, governed/comprehensive/hardened assurance verdicts, a ready production scorecard, and measured outcome KPIs. |

Even a ready scorecard is **advisory, not production certification**.
Remediation, architecture review, customer approvals, and production deployment
remain separate decisions. Agent Hooks is a cooperative alpha, not a security
boundary; governed-action evidence demonstrates conformance, not certification.

Business value is also measured, not assumed. **SPEC § 14** records the baseline,
target, owner, timeframe, measurement source, and maturity policy. The value
evidence progresses from a forecast to **settled Azure actuals**, reconciliation,
and **cost per successful interaction**. Those actuals and customer-environment
onboarding have their own timelines beyond the initial pilot.

## Example: retail returns triage

The [returns-triage example](examples/returns-triage-governed/README.md) shows
what the pipeline produces. Given a return or order ID, the agent correlates
order, return, and customer records, applies return-policy rules, and recommends
approval, denial, escalation, or requesting more information, with policy
citations and an audit record.

It includes the specification, sample data, agent code, infrastructure, and
governance reports. **It is a sanitized historical run capture, not a template
you can deploy unchanged.** Its committed assessment explicitly reports
remaining production-readiness gaps.

## Get started

You do not need to learn all 23 skill names. Choose an entry point:

| Your starting point | Start with |
|---|---|
| An idea that needs sizing and discovery | [`threadlight-qualify`](skills/threadlight-qualify/SKILL.md), before creating a repository. |
| A business brief that needs a specification | [`threadlight-design`](skills/threadlight-design/SKILL.md). |
| A pilot you want the coding assistant to guide through the lifecycle | [`threadlight-auto`](skills/threadlight-auto/SKILL.md), after reviewing its deployment prerequisites. |
| An existing deployed pilot | [`threadlight-safe-check`](skills/threadlight-safe-check/SKILL.md), then the relevant assessment skills. |
| An exported Kratos agent project | The [Kratos bridge](#starting-from-a-kratos-export); do not regenerate its runtime. |

### Install

With GitHub Copilot CLI installed, add the released plugin:

```bash
copilot plugin marketplace add aiappsgbb/threadlight-skills
copilot plugin install threadlight-skills@threadlight-skills
```

Then start Copilot in your intended pilot workspace and ask for a design, for
example:

> Use threadlight-design to specify a retail returns-triage assistant.
> It should recommend a decision with a cited policy clause, use mock order
> and customer data, and leave refund execution to a human. Stop after the
> specification for review.

The first deliverable is a reviewable `specs/SPEC.md`, not a deployment.
Continue with local testing or deployment when the specification is ready.

**Before deploying:** install the [companion skills](#companion-skills-in-awesome-gbb)
and use an environment with the required Azure tooling, credentials,
permissions, and quota. The [Auto preflight](skills/threadlight-auto/SKILL.md#stage-0--preflight)
documents the tool versions and tenant/subscription checks. Installing this
plugin alone does not provide Azure access or a deployment environment.

For an individual skill instead of the plugin:

```bash
gh skill install aiappsgbb/threadlight-skills threadlight-design
```

## Quickstart in GitHub Codespaces

Want to try the skills without installing anything? Open this repo in a
Codespace and you get **GitHub Copilot CLI with all 23 threadlight skills
pre-wired** from the checkout.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/aiappsgbb/threadlight-skills)

The [`.devcontainer`](.devcontainer/) installs Copilot CLI and registers the
skills automatically. Once it boots:

```bash
copilot          # start Copilot CLI
/login           # first launch only — sign in via device flow
```

Then just prompt, e.g. *"use threadlight-design to draft a SPEC from this
brief: …"*.

The Codespace uses the local checkout. To use the released version instead,
follow the [plugin installation](#install) instructions above.

### In a GitHub cloud sandbox

Just enabled **[cloud sandboxes](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes)**
for your org? You can run the skills in a fully isolated, **ephemeral Linux box
hosted by GitHub** — nothing installed locally, and you can pick the session back
up from any machine:

```bash
copilot --cloud    # launch an ephemeral cloud sandbox (public preview)
```

A cloud sandbox **does not read `.devcontainer/`**, so the auto-wiring above
doesn't apply — install the skills from the marketplace the same way you would
anywhere:

```bash
copilot plugin marketplace add aiappsgbb/threadlight-skills
copilot plugin install threadlight-skills@threadlight-skills
```

A few things to know:

- **Governance is inherited.** Each session runs under your org's existing
  **Copilot cloud agent policies** — the firewall/allow-list your admins already
  trust — with no extra setup. For the deploy and cost skills to reach Azure,
  that policy needs to allow the hosts they call: `management.azure.com`,
  `*.services.ai.azure.com`, `ai.azure.com`, `login.microsoftonline.com`,
  `sts.windows.net`, `prices.azure.com`, `github.com`, `ghcr.io`,
  `mcr.microsoft.com` and `learn.microsoft.com`.
- **No Azure deploy tooling.** Like the Codespace, a cloud sandbox has no
  `az` / `azd` / `bicep` / Docker or subscription credentials preloaded, so the
  deploy and production-hardening legs still need a full local or in-VNet box.
- **Preview + usage-billed.** Cloud sandboxes are in **public preview** and
  billed by usage — stopping a session snapshots it; deleting it frees the
  storage.

### Limitations

The Codespace is a **thin, consumer-focused** box for authoring and exploring
skills — not a full deploy environment:

- **Auth:** the first `copilot` launch needs `/login`. Codespaces injects a
  repo-scoped `GITHUB_TOKEN` that lacks the *Copilot Requests* permission; if it
  interferes with sign-in, run `unset GITHUB_TOKEN` in the terminal and retry
  `/login`.
- **No Azure deploy tooling** (`azd`, `az`, `bicep`, Docker) — the deploy and
  production-hardening legs (`threadlight-deploy`, `threadlight-safe-check`,
  `threadlight-production-ready`, …) need a full local or in-VNet environment.
  See [`threadlight-customize`](skills/threadlight-customize/) for private-env
  testing patterns.
- Some MCP/agent tools (e.g. workiq) may not function in a Codespace.

## Companion skills (in awesome-gbb)

Threadlight skills cross-reference foundry-*, azd-patterns, citadel-*, and
other skills from [awesome-gbb](https://github.com/aiappsgbb/awesome-gbb).

Threadlight is deliberately **thin where the foundry-\* family is already deep** —
it composes with those skills rather than reimplementing them:

| Companion (awesome-gbb) | Threadlight composes with it for |
|---|---|
| [`foundry-skill-catalog`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-skill-catalog) | Publishing skills/tools as **versioned, immutable Foundry artifacts** — pin a version, promote `default_version` in stages, download at deploy. This is the lifecycle `threadlight-production-ready`'s supply-chain pillar checks (SUP-008/009). |
| [`foundry-toolbox`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-toolbox) | Curating the **tool set** an agent binds to, versioned alongside its skills. |
| [`foundry-evals`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-evals) | Offline batch invoke + score behind `threadlight-evals`. |
| [`foundry-agt`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-agt) | Agent-runtime governance policy behind `threadlight-govern`. |
| [`foundry-hosted-agents`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-hosted-agents) · [`azd-patterns`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/azd-patterns) · [`foundry-observability`](https://github.com/aiappsgbb/awesome-gbb/tree/main/skills/foundry-observability) | Hosting, deploy hooks, and OTel wiring the deploy leg builds on. |

Install both plugins for the full pipeline:

```bash
copilot plugin marketplace add aiappsgbb/awesome-gbb
copilot plugin install awesome-gbb@awesome-gbb
```

The commands above add the companion plugin; install Threadlight itself using
the [installation steps](#install).

## Starting from a Kratos export

Threadlight can also assess and extend a **Kratos-exported agent project**.
This path bypasses from-scratch design: the deployment skill preserves the
exported runtime, enriches and validates the project, and fills in evaluation
artifacts. You can then apply the deployment checks, cost analysis, and
production-readiness assessment.

Follow the [Kratos bridge guide](docs/KRATOS-BRIDGE.md) for export detection,
prerequisites, and the invocation order. It is an alternative entry path, not a
requirement for using Threadlight.

## Skill catalog

All **23 skills** are listed below. Follow a skill link for its prerequisites,
inputs, outputs, commands, and safety boundaries; the
[technical briefing](THREADLIGHT.md) explains how they compose.

| Area | Skill | Purpose |
|---|---|---|
| Entry | [`threadlight-qualify`](skills/threadlight-qualify/SKILL.md) | Size a workload and capture discovery inputs without a repository or Azure access. |
| Design | [`threadlight-design`](skills/threadlight-design/SKILL.md) | Turn a brief into a specification, technical foundation, and derived agent instructions. |
| Build | [`threadlight-demo-data-factory`](skills/threadlight-demo-data-factory/SKILL.md) | Generate industry-realistic sample data. |
| Build | [`threadlight-local-test`](skills/threadlight-local-test/SKILL.md) | Run the agent locally for rapid iteration. |
| Build | [`threadlight-hitl-patterns`](skills/threadlight-hitl-patterns/SKILL.md) | Add human-in-the-loop approvals through Teams cards and audit trails. |
| Build | [`threadlight-workspace-ui`](skills/threadlight-workspace-ui/SKILL.md) | Supply operator-workspace patterns in vanilla HTML and JavaScript behind Easy Auth. |
| Build | [`threadlight-event-triggers`](skills/threadlight-event-triggers/SKILL.md) | Add scheduled or event-driven execution. |
| Deploy | [`threadlight-deploy`](skills/threadlight-deploy/SKILL.md) | Orchestrate infrastructure and agent deployment through Azure Developer CLI. |
| Check | [`threadlight-safe-check`](skills/threadlight-safe-check/SKILL.md) | Validate resource selectors and pre/post-deployment configuration. |
| Cost | [`threadlight-consumption-iq`](skills/threadlight-consumption-iq/SKILL.md) | Forecast Azure costs, compare options, and later reconcile actuals and unit costs. |
| Integration | [`threadlight-connect`](skills/threadlight-connect/SKILL.md) | Gate a mock-to-real tool swap on contract, user-scoped authorization, and current-role evidence; writes require explicit apply. |
| Evidence | [`threadlight-ground`](skills/threadlight-ground/SKILL.md) | Assess supplied access-control, citation, and refusal evidence; does not retrieve data or run live probes. |
| Evidence | [`threadlight-evals`](skills/threadlight-evals/SKILL.md) | Coordinate offline quality evaluation, continuous evaluation, and model/prompt comparisons. |
| Evidence | [`threadlight-redteam`](skills/threadlight-redteam/SKILL.md) | Run adversarial safety assessments and report findings. |
| Governance | [`threadlight-govern`](skills/threadlight-govern/SKILL.md) | Scaffold and validate runtime governance policy and middleware wiring. |
| Governance | [`threadlight-governed-actions`](skills/threadlight-governed-actions/SKILL.md) | Assess consequential-action mediation, enforcement, approvals, auditability, and repository change controls. Manual and read-only by default. |
| Evidence | [`threadlight-loadtest`](skills/threadlight-loadtest/SKILL.md) | Capture live latency and error-rate evidence within a budget cap; production endpoints require explicit permission. |
| Readiness | [`threadlight-production-ready`](skills/threadlight-production-ready/SKILL.md) | Produce an advisory scorecard across 13 pillars, consuming fresh evidence from the other assessments. |
| Handoff | [`threadlight-cicd`](skills/threadlight-cicd/SKILL.md) | Generate GitHub Actions or Azure DevOps deployment pipelines and secret-free identity/setup runbooks. |
| Handoff | [`threadlight-customize`](skills/threadlight-customize/SKILL.md) | Guide a customer-specific fork and environment onboarding; runbooks, not automatic rollout. |
| Improve | [`threadlight-router-bench`](skills/threadlight-router-bench/SKILL.md) | Learn from a completed CI run and optionally compare model-router cost and quality. |
| Improve | [`threadlight-upgrade`](skills/threadlight-upgrade/SKILL.md) | Compare dependencies and runtime choices with a dated compatibility matrix; emit a plan without applying upgrades. |
| Coordinate | [`threadlight-auto`](skills/threadlight-auto/SKILL.md) | Plan the next pilot stage from evidence and saved state; the coding assistant executes it. |

## Repository guide

| Path | What to read or inspect |
|---|---|
| [`THREADLIGHT.md`](THREADLIGHT.md) | Detailed engineering reference and lifecycle contracts. |
| [`skills/`](skills/) | Skill instructions, scripts, templates, and per-skill tests. |
| [`examples/`](examples/) | Captured pilot artifacts, including the returns-triage example. |
| [`docs/`](docs/) | Published experience pages, guides, and the Kratos bridge. |
| [Lifecycle Canvas extension](.github/extensions/threadlight-lifecycle/) | Optional Copilot App progress panel. |
| [`tests/`](tests/) | Cross-cutting documentation, canvas, and browser tests. |

## Live experience

The [Threadlight experience page](https://aiappsgbb.github.io/threadlight-skills/)
showcases what the pipeline produces.

## License

[MIT](LICENSE)
