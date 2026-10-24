# Issue tracker: GitHub

Specs and tickets live in GitHub Issues for Ron-it/boson-hack-26.
Use the gh CLI from this checkout, or pass --repo Ron-it/boson-hack-26.

## Operations

- Create: gh issue create --title "..." --body-file <file>
- Read: gh issue view <number> --json number,title,body,labels,comments
- List: gh issue list --state open --json number,title,body,labels,assignees
- Comment: gh issue comment <number> --body-file <file>
- Label: gh issue edit <number> --add-label "<label>"
- Close: gh issue close <number>

Use actual newlines in body files.

## Specs and dependencies

Link implementation tickets to their spec through GitHub sub-issues.
If unavailable, put "Part of #<spec>" in each ticket and maintain a
task list in the spec issue.

Use native GitHub issue dependencies for blocking relationships:
POST repos/Ron-it/boson-hack-26/issues/<ticket>/dependencies/blocked_by
with issue_id set to the blocker's numeric database ID, not its issue number.
If unavailable, put "Blocked by: #<number>" at the top of the ticket.

A ticket is ready when all its blockers are closed and it is unclaimed.
Claim it with gh issue edit <number> --add-assignee @me.

## Completion

PRs should reference the spec and tickets they resolve using GitHub
closing keywords. Resolve work through the merged implementation PR;
a draft PR or completed subagent is not a closed ticket.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill instructions

"Publish to the issue tracker" means create a GitHub issue.
"Fetch the relevant ticket" means read the GitHub issue and its comments.
