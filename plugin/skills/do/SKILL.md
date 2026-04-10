---
name: do
description: Execute a phased implementation plan using subagents. Use when asked to execute, run, or carry out a plan — especially one created by make-plan.
---

# Do Plan

**BEGIN IMMEDIATELY.** When this skill activates, start Plan Discovery right away — do not wait for additional user input.

You are an ORCHESTRATOR. Deploy subagents to execute *all* work. Do not do the work yourself except to coordinate, route context, and verify that each subagent completed its assigned checklist.

**Platform notes:**
- If subagents (Agent tool) are not available, execute the work directly yourself phase by phase.
- For MCP tools: try the tool call first. If unavailable, use the HTTP fallback shown alongside each tool call.

## Plan Discovery (ALWAYS FIRST)

Before executing, find the plan. Follow this priority order:

1. **If a plan is already in context** (e.g., the user pasted it or referenced a file) — use it directly
2. **If the user named a plan** (e.g., `do add-user-auth`) — look for `.claude/plans/add-user-auth.md` and `~/.claude/plans/add-user-auth.md`
3. **Otherwise, query the plan registry** for pending plans:
   - Via MCP tool: `list_plans(project="<project-name>", status="pending")`
   - Via HTTP (use if MCP tool is not available): `curl -s --retry 3 --retry-delay 2 --retry-all-errors "http://localhost:37777/api/plans?project=<project-name>&status=pending"`
   - The project name is the basename of the current working directory
4. **If the registry returns nothing**, scan BOTH of these locations for plan files (glob `*.md`):
   - `.claude/plans/` (project-level plans)
   - `~/.claude/plans/` (user-level plans — Claude Code saves plans here by default)
5. **If multiple pending plans exist** — show them to the user and ask which to execute
6. **If no plans found anywhere** — tell the user: "No pending plans found. Run `make-plan` first to create one."

Once a plan is selected:
- Read the plan file from its `file_path`
- **Show the plan summary to the user and ask for confirmation before executing.** Display the phase names, key tasks, and total phase count. Wait for the user to approve before proceeding.
- Mark it as in-progress: `update_plan(id=<plan-id>, status="in_progress")` (HTTP fallback: `curl -s --retry 3 --retry-delay 2 --retry-all-errors -X PATCH "http://localhost:37777/api/plans/<plan-id>" -H 'Content-Type: application/json' -d '{"status":"in_progress"}'`)
- After all phases complete successfully: `update_plan(id=<plan-id>, status="completed")`
- If abandoned: `update_plan(id=<plan-id>, status="abandoned")`

## Execution Protocol

### Rules

- Each phase uses fresh subagents where noted (or when context is large/unclear)
- Assign one clear objective per subagent and require evidence (commands run, outputs, files changed)
- Do not advance to the next step until the assigned subagent reports completion and the orchestrator confirms it matches the plan

### During Each Phase

Deploy an "Implementation" subagent to:
1. Execute the implementation as specified
2. COPY patterns from documentation, don't invent
3. Cite documentation sources in code comments when using unfamiliar APIs
4. If an API seems missing, STOP and verify — don't assume it exists

### After Each Phase

Deploy subagents for each post-phase responsibility:
1. **Run verification checklist** — Deploy a "Verification" subagent to prove the phase worked
2. **Anti-pattern check** — Deploy an "Anti-pattern" subagent to grep for known bad patterns from the plan
3. **Code quality review** — Deploy a "Code Quality" subagent to review changes
4. **Commit only if verified** — Deploy a "Commit" subagent *only after* verification passes; otherwise, do not commit

### Between Phases

Deploy a "Branch/Sync" subagent to:
- Push to working branch after each verified phase
- Prepare the next phase handoff so the next phase's subagents start fresh but have plan context

## Failure Modes to Prevent

- Don't invent APIs that "should" exist — verify against docs
- Don't add undocumented parameters — copy exact signatures
- Don't skip verification — deploy a verification subagent and run the checklist
- Don't commit before verification passes (or without explicit orchestrator approval)
