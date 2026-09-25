# Contributing

## Branch Strategy

This repository uses a classic two-branch flow:

- `master`: production/stable branch
- `develop`: integration branch for ongoing work

## Workflow

1. Create feature branches from `develop`.
2. Open pull requests into `develop` for normal development and integration.
3. Open release pull requests from `develop` into `master` when promoting changes to production.
4. Create hotfix branches from `master` for urgent production fixes.
5. After a hotfix is merged to `master`, merge/cherry-pick it back into `develop`.

## Branch Protection Rules

### `master` (strict)

- Require pull requests before merging
- Require at least 1–2 approvals
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Restrict direct pushes (optionally including admins)
- Disallow force pushes and branch deletion

### `develop` (lighter)

- Require pull requests before merging
- Require at least 1 approval
- Require status checks to pass (if CI runs on `develop`)
- Disallow force pushes and branch deletion

## Pull Request Guidelines

- Keep pull requests focused and small when possible.
- Ensure relevant tests/checks pass before requesting review.
- Use clear PR titles and descriptions that explain intent and impact.

## Optional: Repository Rulesets

GitHub repository rulesets can be used to apply and centralize these protections for both `master` and `develop` consistently.
