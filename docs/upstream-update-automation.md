# SC: Evo update automation

The scheduled workflow checks the official SC: Evo post list daily at 12:00 Korea time. If `Patch.csv` does not yet include the next official `* Patch Notes` version, it downloads the English markdown source, asks Codex to update `app.js` and `Patch.csv`, runs a JavaScript syntax check, and opens a review pull request. It does not merge or publish the pull request.

## One-time GitHub setup

1. In the repository, open **Settings → Secrets and variables → Actions → New repository secret**.
2. Add `OPENAI_API_KEY`. Codex Action requires an OpenAI API key; API usage is billed separately from a ChatGPT subscription. Use an API project with a budget limit.
3. Open **Settings → Actions → General** and enable **Allow GitHub Actions to create and approve pull requests**.
4. Ensure GitHub Pages deploys from `main`. Merging a reviewed update PR into `main` will then trigger the usual Pages deployment.

The workflow can be run manually from **Actions → Prepare SC Evo update PR → Run workflow**. The daily schedule checks for the earliest update newer than the version recorded in the first version row of `Patch.csv`. If a PR for that version is already open, it will not spend API usage or create a duplicate.

## Review expectations

The official post is the source of truth. The PR should update only facts represented accurately by the current `UNIT_DATA` model and list unsupported gameplay changes in `automation-reports/`. Review names, values, game-speed conversions, race grouping, structure-before-unit ordering, and all unresolved report entries before merging.
