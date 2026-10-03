# SC: Evo update-link automation

GitHub Actions checks the official SC: Evo post list daily at 12:00 Korea time. When it finds a `* Patch Notes` release newer than the latest version in `Patch.csv`, it inserts a new version-only row at the top of `Patch.csv` and pushes that CSV change to the branch that triggered the workflow. The row contains no patch details; the version badge links to the official post. GitHub Pages then publishes the change through its normal deployment flow.

No OpenAI API key or GitHub PAT is used. The workflow uses GitHub's built-in Actions token.

## One-time GitHub setup

1. In **Settings → Actions → General → Workflow permissions**, allow read and write permissions so the workflow can push `Patch.csv`.
2. Ensure GitHub Pages deploys from the `main` branch. The scheduled workflow runs against the default branch; a successful push to `main` is published by Pages.
3. If `main` has branch protection that blocks GitHub Actions pushes, allow the Actions bot to update the branch or the workflow push will fail.

You can also run **Actions → Add SC Evo patch link → Run workflow** manually. After the version-only block appears on the site, add the Korean patch details in the usual patch editor. English display continues to use the app's translation rules; send any new or awkward lines here for translation review.

The workflow does not download or translate the article, edit `app.js` gameplay data, generate patch details, create a PR, or merge unrelated changes. It only adds the official version row to `Patch.csv`.
