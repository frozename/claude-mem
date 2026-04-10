/**
 * Plans Routes
 *
 * Cross-CLI plan handoff: register plans from make-plan, discover them in do.
 *
 * POST   /api/plans      - Register a new plan
 * GET    /api/plans       - List plans for a project (optionally filtered by status)
 * GET    /api/plans/:id   - Get a single plan by ID
 * PATCH  /api/plans/:id   - Update plan status or current phase
 */

import express, { Request, Response } from 'express';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

export class PlansRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/plans', this.handleRegisterPlan.bind(this));
    app.get('/api/plans', this.handleListPlans.bind(this));
    app.get('/api/plans/:id', this.handleGetPlan.bind(this));
    app.patch('/api/plans/:id', this.handleUpdatePlan.bind(this));
  }

  private handleRegisterPlan = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { project, name, filePath, description, phaseCount, platformSource, createdBySession } = req.body;

    if (!project || typeof project !== 'string') { this.badRequest(res, 'project is required'); return; }
    if (!name || typeof name !== 'string') { this.badRequest(res, 'name is required'); return; }
    if (!filePath || typeof filePath !== 'string') { this.badRequest(res, 'filePath is required'); return; }

    const sessionStore = this.dbManager.getSessionStore();
    const result = sessionStore.registerPlan({ project, name, filePath, description, phaseCount, platformSource, createdBySession });

    logger.info('HTTP', 'Plan registered', { id: result.id, project, name });
    res.status(201).json({ success: true, id: result.id, name, project, createdAtEpoch: result.createdAtEpoch, message: `Plan "${name}" registered as #${result.id}` });
  });

  private handleListPlans = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.query.project as string;
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 10;

    if (!project) { this.badRequest(res, 'project query parameter is required'); return; }

    // Auto-register unregistered plan files from ~/.claude/plans/
    await this.autoRegisterPlans(project);

    const sessionStore = this.dbManager.getSessionStore();
    const plans = sessionStore.getPlans(project, status, limit);
    res.json({ plans, total: plans.length, project, filter: status || 'all' });
  });

  /**
   * Scan ~/.claude/plans/ for plan files not yet registered in any project.
   * Registers discovered plans under the querying project.
   */
  private async autoRegisterPlans(queryProject: string): Promise<void> {
    const plansDir = join(homedir(), '.claude', 'plans');
    if (!existsSync(plansDir)) return;

    const store = this.dbManager.getSessionStore();
    const registeredPaths = store.getAllRegisteredPlanPaths();

    let registered = 0;
    try {
      const files = (await readdir(plansDir)).filter(f => f.endsWith('.md'));

      for (const file of files) {
        try {
          const filePath = join(plansDir, file);
          if (registeredPaths.has(filePath)) continue;

          const name = basename(file, '.md');
          const content = (await readFile(filePath, 'utf-8')).slice(0, 2000);

          // Try to extract phase count from content
          const phaseMatches = content.match(/## Phase \d+/gi);
          const phaseCount = phaseMatches ? phaseMatches.length : undefined;

          // Extract a description from the first heading or first line
          const headingMatch = content.match(/^#\s+(.+)/m);
          const description = headingMatch ? headingMatch[1].slice(0, 200) : undefined;

          store.registerPlan({
            project: queryProject,
            name,
            filePath,
            description,
            phaseCount,
            platformSource: 'auto-registered',
          });
          registered++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!msg.includes('UNIQUE constraint') && !msg.includes('duplicate')) {
            logger.debug('HTTP', 'Unexpected error auto-registering plan', { file, error: msg });
          }
        }
      }
    } catch {
      // Directory read error — skip silently
    }

    if (registered > 0) {
      logger.info('HTTP', `Auto-registered ${registered} plan(s) from ${plansDir}`, { project: queryProject });
    }
  }

  private handleGetPlan = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const sessionStore = this.dbManager.getSessionStore();
    const plan = sessionStore.getPlanById(id);
    if (!plan) { this.notFound(res, `Plan #${id} not found`); return; }
    res.json(plan);
  });

  private handleUpdatePlan = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const { status, currentPhase } = req.body;
    if (!status && currentPhase === undefined) { this.badRequest(res, 'At least one of status or currentPhase is required'); return; }
    if (status && !['pending', 'in_progress', 'completed', 'abandoned'].includes(status)) {
      this.badRequest(res, 'status must be one of: pending, in_progress, completed, abandoned'); return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const updated = sessionStore.updatePlan(id, { status, currentPhase });
    if (!updated) { this.notFound(res, `Plan #${id} not found`); return; }

    const plan = sessionStore.getPlanById(id);
    res.json({ success: true, plan, message: `Plan #${id} updated` });
  });
}
