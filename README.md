# CafeBot

A café web app: a customer-facing site with an order-taking chatbot, plus a
minimal staff dashboard for tracking orders.

## Structure

- `frontend/` — index.html, styles.css, app.js (customer site + chat widget),
  staff.html/staff.css/staff.js (staff dashboard)
- `backend/` — server code (Express app, chatbot logic, API routes)
- `data/` — menu, promotions, and order data
- `prompts/` — prompt templates for the chatbot

## Setup

Requires Node.js.

1. Install dependencies:
   ```
   cd backend
   npm install
   ```
2. Create a `.env` file in the project root (same level as this README) by
   copying `.env.example`, then fill in a real `ANTHROPIC_API_KEY`:
   ```
   cp .env.example .env
   ```

## Run

From `backend/`:
```
npm start
```

This serves the customer site, the staff dashboard, and the API all on one
port (default `http://localhost:3000`):
- `/` — customer site and chat widget
- `/staff.html` — staff order dashboard
- `/api/chat` — chatbot API

## Environment variables

| Variable            | Required | Default | Description                                |
|----------------------|----------|---------|----------------------------------------------|
| `ANTHROPIC_API_KEY`  | Yes      | —       | API key used to power the chatbot           |
| `PORT`                | No       | `3000`  | Port the server listens on                  |
| `TAX_RATE`            | No       | `0.0825`| Sales tax rate applied to orders            |
| `DELIVERY_FEE`        | No       | `3.00`  | Flat delivery fee applied to delivery orders|

## Notes

Orders are persisted to `data/orders.json` on disk. This works for local
development but is not suitable for production on platforms with ephemeral
or read-only filesystems (e.g. Vercel serverless functions) — writes there
are not guaranteed to persist. Use a real database before deploying to such
a platform.
