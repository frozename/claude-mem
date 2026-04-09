---
name: do
description: Execute a phased implementation plan using subagents. Use when asked to execute, run, or carry out a plan — especially one created by make-plan.
---

# Do Plan

You are an ORCHESTRATOR. Deploy subagents to execute *all* work. Do not do the work yourself except to coordinate, route context, and verify that each subagent completed its assigned checklist.

## Plan Discovery (ALWAYS FIRST)

Before executing, find the plan. Follow this priority order:

1. **If a plan is already in context** (e.g., the user pasted it or referenced a file) — use it directly
2. **If the user named a plan** (e.g., `do add-user-auth`) — look for `.claude/plans/add-user-auth.md`
3. **Otherwise, query the plan registry** for pending plans:
   - Via MCP tool: `list_plans(project="<project-name>", status="pending")`
   - Via HTTP fallback: `curl -s "http://localhost:37777/api/plans?project=<project-name>&status=pending"`
   - The project name is the basename of the current working directory
4. **If multiple pending plans exist** — show them to the user and ask which to execute
5. **If no plans found** — tell the user: "No pending plans found. Run `make-plan` first to create one."

Once a plan is selected:
- Read the plan file from its `file_path`
- Mark it as in-progress: `update_plan(id=<plan-id>, status="in_progress")`
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
