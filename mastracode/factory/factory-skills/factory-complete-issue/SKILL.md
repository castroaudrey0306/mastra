---
name: factory-complete-issue
description: Mark a GitHub issue as done and update its status labels
---

# Factory Complete Issue

Mark the GitHub issue behind a completed Factory work item as done and update its status labels.

Parse the issue URL or number from `$ARGUMENTS`, then read its current state and labels. Remove any of these labels that are present:

- `status: needs triage`
- `status: auto-triaged`
- `status: needs approval`

Make one `github_update_issue_labels` call that removes whichever listed triage labels are present. For an open issue, the same call also adds `status: pending-close` when it is not already present. Then, unless the open issue already has it, call `github_comment_issue` with the issue number and this exact body:

> This issue has now been marked as done.

If the issue is already closed, still remove the listed triage labels, but do not add `status: pending-close` or post the comment. Do not modify any other labels or issue fields.

Never use `gh issue edit`, `gh issue comment`, raw provider APIs, or credentials from the environment for these mutations. The brokered tools preserve Factory's stable provider identity; the comment tool also appends the current session attribution.

Do not close, reopen, or assign the issue, and do not request another Factory transition.
