# CafeBot

## Purpose

CafeBot is a café web app: a customer-facing site/chatbot experience for a
café (browsing menu, asking questions, placing orders, etc.). This file
guides any AI assistant working in this repo.

## Architecture Overview

- `frontend/` — static client: `index.html`, `styles.css`, `app.js`. Talks
  to the backend over HTTP.
- `backend/` — server code that serves API endpoints and handles business
  logic (e.g. menu data, orders, chatbot responses).
- `data/` — static or seed data (e.g. menu items, prices) consumed by the
  backend and/or frontend.
- `prompts/` — prompt templates used for any LLM-driven features (e.g. the
  chatbot).
- `README.md` — project overview and structure.

Data flows: `frontend` → `backend` → `data` / `prompts`. Keep this
separation; don't embed backend logic in the frontend or vice versa.

## Coding Rules

- Keep the existing folder separation (`frontend`, `backend`, `data`,
  `prompts`). Don't mix concerns across them.
- Prefer minimal, readable code over clever abstractions. No speculative
  features or unused scaffolding.
- No comments unless they explain a non-obvious "why".
- Match existing style/conventions in a file before introducing new ones.
- Don't add new dependencies unless necessary for the task at hand.

## Security Rules

- Never hardcode secrets, API keys, or credentials in any file. Use
  environment variables / a `.env` file (git-ignored) instead.
- Validate and sanitize all user input on the backend, not just the
  frontend.
- Never commit `.env` files or other secret material.
- Avoid introducing common web vulnerabilities (XSS, SQL injection,
  command injection, CSRF, etc.) — sanitize output, use parameterized
  queries, and follow OWASP guidance.
- Don't log sensitive user data (payment info, personal identifiers).

## Token-Saving Rules

- Read only the files relevant to the current task, not the whole repo.
- Don't restate file contents back in responses; reference file paths
  instead.
- Keep responses and explanations concise — avoid restating obvious code
  behavior.
- Avoid regenerating unchanged files; use targeted edits.

## Scope Discipline

- Only modify the files needed for the current task. Do not refactor,
  reformat, or touch unrelated files "while you're in there."
