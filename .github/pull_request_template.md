## Summary

One or two sentences: what changed. A reviewer should be able to stop here and
know what they're looking at.

## Why

The problem this solves, and why this approach. Link the issue if there is one.

## Repos affected

- [ ] meridies-landing
- [ ] meridies-demo
- [ ] meridies-app
- [ ] meridies-backend

## How I tested

- [ ] `npm run typecheck` and `npm run build` clean
- [ ] `GET /health` returns `{ "status": "ok" }`
- [ ] Clicked through / exercised: <!-- specific route or flow -->

## Migrations / env changes

- [ ] Schema migration included
- [ ] Deploy order stated: what happens if this code runs before its migration, and whether it is in `REQUIRED_SCHEMA`
- [ ] The migration is safe while the previous build still serves (drops and renames go in a later PR)
- [ ] After merge: the Apply migrations run's plan lists only the files expected (the approver checks)
- [ ] New env var — added to `.env.example` AND set on Railway
- [ ] None

## Risk

What breaks if this is wrong, and how to roll it back.
