/**
 * GeminiCliHooksInstaller - Gemini CLI integration for claude-mem
 *
 * Installs hooks into ~/.gemini/settings.json using the unified CLI:
 *   bun worker-service.cjs hook gemini-cli <event>
 *
 * This routes through the hook-command.ts framework:
 *   readJsonFromStdin() → gemini-cli adapter → event handler → POST to worker
 *
 * Gemini CLI supports 11 lifecycle hooks; we register 8 that map to
 * useful memory events. See src/cli/adapters/gemini-cli.ts for the
 * adapter that normalizes Gemini's stdin JSON to NormalizedHookInput.
 *
 * Hook config format (verified against Gemini CLI source):
 *   {
 *     "hooks": {
 *       "AfterTool": [{
 *         "matcher": "*",
 *         "hooks": [{ "name": "claude-mem", "type": "command", "command": "...", "timeout": 5000 }]
 *       }]
 *     }
 *   }
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, lstatSync, unlinkSync, cpSync, rmSync } from 'fs';
import { findWorkerServicePath, findBunPath } from './CursorHooksInstaller.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

// ============================================================================
// Types
// ============================================================================

/** A single hook entry in a Gemini CLI hook group */
interface GeminiHookEntry {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
}

/** A hook group — matcher selects which tools/events this applies to */
interface GeminiHookGroup {
  matcher: string;
  hooks: GeminiHookEntry[];
}

/** The hooks section in ~/.gemini/settings.json */
interface GeminiHooksConfig {
  [eventName: string]: GeminiHookGroup[];
}

/** Full ~/.gemini/settings.json structure (partial — we only care about hooks) */
interface GeminiSettingsJson {
  hooks?: GeminiHooksConfig;
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_CONFIG_DIR, 'settings.json');
const GEMINI_MD_PATH = path.join(GEMINI_CONFIG_DIR, 'GEMINI.md');

const GEMINI_SKILLS_DIR = path.join(GEMINI_CONFIG_DIR, 'skills');
const GEMINI_COMMANDS_DIR = path.join(GEMINI_CONFIG_DIR, 'commands', 'claude-mem');
const GEMINI_EXTENSIONS_DIR = path.join(GEMINI_CONFIG_DIR, 'extensions');
const GEMINI_EXTENSION_DIR = path.join(GEMINI_EXTENSIONS_DIR, 'claude-mem');
const GEMINI_ENABLEMENT_PATH = path.join(GEMINI_EXTENSIONS_DIR, 'extension-enablement.json');
const SKILL_PREFIX = 'claude-mem-';

const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_MS = 10000;

/**
 * Mapping from Gemini CLI hook events to internal claude-mem event types.
 *
 * These events are processed by hookCommand() in src/cli/hook-command.ts,
 * which reads stdin via readJsonFromStdin(), normalizes through the
 * gemini-cli adapter, and dispatches to the matching event handler.
 *
 * Events NOT mapped (too chatty for memory capture):
 *   BeforeModel, AfterModel, BeforeToolSelection
 */
const GEMINI_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'SessionStart': 'context',
  'BeforeAgent': 'user-message',
  'AfterAgent': 'observation',
  'BeforeTool': 'observation',
  'AfterTool': 'observation',
  'PreCompress': 'summarize',
  'Notification': 'observation',
  'SessionEnd': 'session-complete',
};

// ============================================================================
// Hook Command Builder
// ============================================================================

/**
 * Build the hook command string for a given Gemini CLI event.
 *
 * The command invokes worker-service.cjs with the `hook` subcommand,
 * which delegates to hookCommand('gemini-cli', event) — the same
 * framework used by Claude Code and Cursor hooks.
 *
 * Pipeline: bun worker-service.cjs hook gemini-cli <event>
 *   → worker-service.ts parses args, ensures worker daemon is running
 *   → hookCommand('gemini-cli', '<event>')
 *   → readJsonFromStdin() reads Gemini's JSON payload
 *   → geminiCliAdapter.normalizeInput() → NormalizedHookInput
 *   → eventHandler.execute(input)
 *   → geminiCliAdapter.formatOutput(result)
 *   → JSON.stringify to stdout
 */
function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  geminiEventName: string,
): string {
  const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[geminiEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Gemini CLI event: ${geminiEventName}`);
  }

  // Double-escape backslashes intentionally: this command string is embedded inside
  // a JSON value, so `\\` in the source becomes `\` when the JSON is parsed by the
  // IDE. Without double-escaping, Windows paths like C:\Users would lose their
  // backslashes and break when the IDE deserializes the hook configuration.
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook gemini-cli ${internalEvent}`;
}

/**
 * Create a hook group entry for a Gemini CLI event.
 * Uses matcher "*" to match all tools/contexts for that event.
 */
function createHookGroup(hookCommand: string): GeminiHookGroup {
  return {
    matcher: '*',
    hooks: [{
      name: HOOK_NAME,
      type: 'command',
      command: hookCommand,
      timeout: HOOK_TIMEOUT_MS,
    }],
  };
}

// ============================================================================
// Settings JSON Management
// ============================================================================

/**
 * Read ~/.gemini/settings.json, returning empty object if missing.
 * Throws on corrupt JSON to prevent silent data loss.
 */
function readGeminiSettings(): GeminiSettingsJson {
  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    return {};
  }

  const content = readFileSync(GEMINI_SETTINGS_PATH, 'utf-8');
  try {
    return JSON.parse(content) as GeminiSettingsJson;
  } catch (error) {
    throw new Error(`Corrupt JSON in ${GEMINI_SETTINGS_PATH}, refusing to overwrite user settings`);
  }
}

/**
 * Write settings back to ~/.gemini/settings.json.
 * Creates the directory if it doesn't exist.
 */
function writeGeminiSettings(settings: GeminiSettingsJson): void {
  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Deep-merge claude-mem hooks into existing settings.
 *
 * For each event:
 * - If the event already has a hook group with a claude-mem hook, update it
 * - Otherwise, append a new hook group
 *
 * Preserves all non-claude-mem hooks and all non-hook settings.
 */
function mergeHooksIntoSettings(
  existingSettings: GeminiSettingsJson,
  newHooks: GeminiHooksConfig,
): GeminiSettingsJson {
  const settings = { ...existingSettings };
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventName, newGroups] of Object.entries(newHooks)) {
    const existingGroups: GeminiHookGroup[] = settings.hooks[eventName] ?? [];

    // For each new hook group, check if there's already a group
    // containing a claude-mem hook — update it in place
    for (const newGroup of newGroups) {
      const existingGroupIndex = existingGroups.findIndex((group: GeminiHookGroup) =>
        group.hooks.some((hook: GeminiHookEntry) => hook.name === HOOK_NAME)
      );

      if (existingGroupIndex >= 0) {
        // Update existing group: replace the claude-mem hook entry
        const existingGroup: GeminiHookGroup = existingGroups[existingGroupIndex];
        const hookIndex = existingGroup.hooks.findIndex((hook: GeminiHookEntry) => hook.name === HOOK_NAME);
        if (hookIndex >= 0) {
          existingGroup.hooks[hookIndex] = newGroup.hooks[0];
        } else {
          existingGroup.hooks.push(newGroup.hooks[0]);
        }
      } else {
        // No existing claude-mem group — append
        existingGroups.push(newGroup);
      }
    }

    settings.hooks[eventName] = existingGroups;
  }

  return settings;
}

// ============================================================================
// GEMINI.md Context Injection
// ============================================================================

/**
 * Append or update the claude-mem context section in ~/.gemini/GEMINI.md.
 * Uses the same <claude-mem-context> tag pattern as CLAUDE.md.
 */
function setupGeminiMdContextSection(): void {
  const contextTag = '<claude-mem-context>';
  const contextEndTag = '</claude-mem-context>';
  const placeholder = `${contextTag}
# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*
${contextEndTag}`;

  let content = '';
  if (existsSync(GEMINI_MD_PATH)) {
    content = readFileSync(GEMINI_MD_PATH, 'utf-8');
  }

  if (content.includes(contextTag)) {
    // Already has claude-mem section — leave it alone (may have real context)
    return;
  }

  // Append the section
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  const newContent = content + separator + placeholder + '\n';

  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_MD_PATH, newContent);
}

// ============================================================================
// Skill Registration
// ============================================================================

/**
 * Find the plugin directory root (contains skills/ and scripts/).
 * Searches marketplace install and development/source locations.
 */
function findPluginDir(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin'),
    path.join(process.cwd(), 'plugin'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'skills')) && existsSync(path.join(dir, 'scripts'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Install claude-mem as a Gemini CLI extension.
 *
 * Creates ~/.gemini/extensions/claude-mem/ with:
 * - gemini-extension.json (with mcpServers config)
 * - skills/ symlinked to plugin skills
 * - scripts/ symlinked to plugin scripts (for MCP server)
 *
 * Also registers the extension in extension-enablement.json and
 * cleans up any legacy individual skill symlinks from ~/.gemini/skills/.
 */
function installGeminiExtension(): { skills: number; mcpConfigured: boolean } {
  const pluginDir = findPluginDir();
  if (!pluginDir) {
    console.log('  Could not find plugin directory — skipping extension registration.');
    return { skills: 0, mcpConfigured: false };
  }

  // Create extension directory
  mkdirSync(GEMINI_EXTENSION_DIR, { recursive: true });

  // Symlink skills/ and scripts/ into the extension
  const links: Array<[string, string]> = [
    [path.join(pluginDir, 'skills'), path.join(GEMINI_EXTENSION_DIR, 'skills')],
    [path.join(pluginDir, 'scripts'), path.join(GEMINI_EXTENSION_DIR, 'scripts')],
  ];

  for (const [source, target] of links) {
    rmSync(target, { recursive: true, force: true });
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      cpSync(source, target, { recursive: true });
    }
  }

  // Count skills
  const skillsDir = path.join(pluginDir, 'skills');
  const skillCount = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
    .length;

  // Write gemini-extension.json with MCP server config
  const extensionManifest = {
    name: 'claude-mem',
    version: getPluginVersion(pluginDir),
    description: 'Persistent memory system — preserve context across Gemini CLI sessions',
    mcpServers: {
      'claude-mem': {
        command: 'node',
        args: ['${extensionPath}/scripts/mcp-server.cjs'],
      },
    },
  };
  writeFileSync(
    path.join(GEMINI_EXTENSION_DIR, 'gemini-extension.json'),
    JSON.stringify(extensionManifest, null, 2) + '\n',
  );

  // Register in extension-enablement.json
  registerExtensionEnablement();

  // Clean up legacy individual skill symlinks from ~/.gemini/skills/
  cleanupLegacySkillSymlinks();

  return { skills: skillCount, mcpConfigured: true };
}

/**
 * Read the plugin version from plugin.json.
 */
function getPluginVersion(pluginDir: string): string {
  try {
    const pluginJson = JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
    return pluginJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Register claude-mem in ~/.gemini/extensions/extension-enablement.json.
 * Enables the extension for all user directories.
 */
function registerExtensionEnablement(): void {
  let enablement: Record<string, unknown> = {};
  if (existsSync(GEMINI_ENABLEMENT_PATH)) {
    try {
      enablement = JSON.parse(readFileSync(GEMINI_ENABLEMENT_PATH, 'utf-8'));
    } catch {
      // corrupt file — overwrite
    }
  }

  enablement['claude-mem'] = { overrides: [`${homedir()}/*`] };
  writeFileSync(GEMINI_ENABLEMENT_PATH, JSON.stringify(enablement, null, 2) + '\n');
}

/**
 * Remove legacy individual skill symlinks from ~/.gemini/skills/claude-mem-*.
 * These were created by an earlier installer version; the extension approach supersedes them.
 */
function cleanupLegacySkillSymlinks(): void {
  if (!existsSync(GEMINI_SKILLS_DIR)) return;

  const entries = readdirSync(GEMINI_SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(SKILL_PREFIX)) continue;
    const entryPath = path.join(GEMINI_SKILLS_DIR, entry.name);
    try {
      if (lstatSync(entryPath).isSymbolicLink()) {
        unlinkSync(entryPath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Find and install Gemini CLI commands (TOML files).
 * Commands provide the prompt that triggers skill execution — without them,
 * Gemini skill activation only loads context but doesn't generate a response.
 *
 * @returns number of commands installed
 */
function installGeminiCommands(): number {
  const pluginDir = findPluginDir();
  if (!pluginDir) return 0;

  const commandsSource = path.join(pluginDir, 'gemini-commands');
  if (!existsSync(commandsSource)) return 0;

  rmSync(GEMINI_COMMANDS_DIR, { recursive: true, force: true });
  mkdirSync(GEMINI_COMMANDS_DIR, { recursive: true });

  const tomlFiles = readdirSync(commandsSource).filter(f => f.endsWith('.toml'));
  let installed = 0;
  const failed: string[] = [];
  for (const file of tomlFiles) {
    try {
      cpSync(path.join(commandsSource, file), path.join(GEMINI_COMMANDS_DIR, file));
      installed++;
    } catch {
      failed.push(file);
    }
  }

  if (failed.length > 0) {
    throw new Error(`Failed to install Gemini command(s): ${failed.join(', ')}`);
  }
  return installed;
}

/**
 * Remove claude-mem Gemini commands directory.
 */
function uninstallGeminiCommands(): void {
  if (!existsSync(GEMINI_COMMANDS_DIR)) return;
  try {
    rmSync(GEMINI_COMMANDS_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Uninstall the claude-mem Gemini extension.
 * Removes the extension directory and its entry in extension-enablement.json.
 * Also cleans up any legacy skill symlinks.
 */
function uninstallGeminiExtension(): void {
  // Remove extension directory
  if (existsSync(GEMINI_EXTENSION_DIR)) {
    rmSync(GEMINI_EXTENSION_DIR, { recursive: true, force: true });
  }

  // Remove from extension-enablement.json
  if (existsSync(GEMINI_ENABLEMENT_PATH)) {
    try {
      const enablement = JSON.parse(readFileSync(GEMINI_ENABLEMENT_PATH, 'utf-8'));
      delete enablement['claude-mem'];
      writeFileSync(GEMINI_ENABLEMENT_PATH, JSON.stringify(enablement, null, 2) + '\n');
    } catch {
      // ignore
    }
  }

  // Clean up legacy skill symlinks
  cleanupLegacySkillSymlinks();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Install claude-mem hooks into ~/.gemini/settings.json.
 *
 * Merges hooks non-destructively: existing settings and non-claude-mem
 * hooks are preserved. Existing claude-mem hooks are updated in place.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installGeminiCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Gemini CLI hooks...\n');

  // Find required paths
  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    // Build hook commands for all mapped events
    const hooksConfig: GeminiHooksConfig = {};
    for (const geminiEvent of Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, geminiEvent);
      hooksConfig[geminiEvent] = [createHookGroup(command)];
    }

    // Read existing settings and merge
    const existingSettings = readGeminiSettings();
    const mergedSettings = mergeHooksIntoSettings(existingSettings, hooksConfig);

    // Write back
    writeGeminiSettings(mergedSettings);
    console.log(`  Merged hooks into ${GEMINI_SETTINGS_PATH}`);

    // Setup GEMINI.md context injection
    setupGeminiMdContextSection();
    console.log(`  Setup context injection in ${GEMINI_MD_PATH}`);

    // Install as Gemini extension (skills + MCP server)
    const ext = installGeminiExtension();
    if (ext.skills > 0) {
      console.log(`  Registered ${ext.skills} skills via extension`);
    }
    if (ext.mcpConfigured) {
      console.log(`  MCP server configured in extension`);
    }

    // Install Gemini commands (TOML files that trigger skill execution)
    const cmdCount = installGeminiCommands();
    if (cmdCount > 0) {
      console.log(`  Installed ${cmdCount} commands (use /claude-mem:<name> in Gemini CLI)`);
    }

    // List installed events
    const eventNames = Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT);
    console.log(`  Registered ${eventNames.length} hook events:`);
    for (const event of eventNames) {
      const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[event];
      console.log(`    ${event} → ${internalEvent}`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${GEMINI_SETTINGS_PATH}
Extension installed to: ${GEMINI_EXTENSION_DIR}
Using unified CLI: bun worker-service.cjs hook gemini-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Gemini CLI to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via ~/.gemini/GEMINI.md
  and automatically included in Gemini CLI conversations.
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Uninstall claude-mem hooks from ~/.gemini/settings.json.
 *
 * Removes only claude-mem hooks — other hooks and settings are preserved.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallGeminiCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Gemini CLI hooks...\n');

  try {
    // Hook removal (conditional — settings may not exist)
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      const settings = readGeminiSettings();
      if (settings.hooks) {
        let removedCount = 0;

        // Remove claude-mem hooks from within each group, preserving other hooks
        for (const [eventName, groups] of Object.entries(settings.hooks)) {
          const filteredGroups = groups
            .map(group => {
              const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
              removedCount += group.hooks.length - remainingHooks.length;
              return { ...group, hooks: remainingHooks };
            })
            .filter(group => group.hooks.length > 0);

          if (filteredGroups.length > 0) {
            settings.hooks[eventName] = filteredGroups;
          } else {
            delete settings.hooks[eventName];
          }
        }

        // Clean up empty hooks object
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        writeGeminiSettings(settings);
        console.log(`  Removed ${removedCount} claude-mem hook(s) from ${GEMINI_SETTINGS_PATH}`);
      } else {
        console.log('  No hooks found in Gemini CLI settings.');
      }
    } else {
      console.log('  No Gemini CLI settings found.');
    }

    // Always clean up remaining artifacts
    if (existsSync(GEMINI_MD_PATH)) {
      let mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
      const contextRegex = /\n?<claude-mem-context>[\s\S]*?<\/claude-mem-context>\n?/;
      if (contextRegex.test(mdContent)) {
        mdContent = mdContent.replace(contextRegex, '');
        writeFileSync(GEMINI_MD_PATH, mdContent);
        console.log(`  Removed context section from ${GEMINI_MD_PATH}`);
      }
    }

    uninstallGeminiExtension();
    console.log(`  Removed extension from ${GEMINI_EXTENSION_DIR}`);
    uninstallGeminiCommands();
    console.log(`  Removed commands from ${GEMINI_COMMANDS_DIR}`);

    console.log('\nUninstallation complete!\n');
    console.log('Restart Gemini CLI to apply changes.');
    return 0;
  } catch (error) {
    console.error(`\nUninstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Check Gemini CLI hooks installation status.
 *
 * @returns 0 always (informational)
 */
export function checkGeminiCliHooksStatus(): number {
  console.log('\nClaude-Mem Gemini CLI Hooks Status\n');

  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    console.log('Gemini CLI settings: Not found');
    console.log(`  Expected at: ${GEMINI_SETTINGS_PATH}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide gemini-cli\n');
  } else {
    let settings: GeminiSettingsJson | null = null;
    try {
      settings = readGeminiSettings();
    } catch (error) {
      console.log(`Gemini CLI settings: ${(error as Error).message}\n`);
    }

    if (settings && settings.hooks) {
      // Check for claude-mem hooks
      const installedEvents: string[] = [];
      for (const [eventName, groups] of Object.entries(settings.hooks)) {
        const hasClaudeMem = groups.some(group =>
          group.hooks.some(hook => hook.name === HOOK_NAME)
        );
        if (hasClaudeMem) {
          installedEvents.push(eventName);
        }
      }

      if (installedEvents.length === 0) {
        console.log('Gemini CLI settings: Found, but no claude-mem hooks\n');
        console.log('Run: claude-mem install --ide gemini-cli\n');
      } else {
        console.log(`Settings: ${GEMINI_SETTINGS_PATH}`);
        console.log(`Mode: Unified CLI (bun worker-service.cjs hook gemini-cli)`);
        console.log(`Events: ${installedEvents.length} of ${Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT).length} mapped`);
        for (const event of installedEvents) {
          const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
          console.log(`  ${event} → ${internalEvent}`);
        }
        console.log('');
      }
    } else if (settings) {
      console.log('Gemini CLI settings: Found, but no hooks configured\n');
      console.log('No hooks installed. Run: claude-mem install --ide gemini-cli\n');
    }
  }

  // Check GEMINI.md context
  if (existsSync(GEMINI_MD_PATH)) {
    const mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`Context: Active (${GEMINI_MD_PATH})`);
    } else {
      console.log('Context: GEMINI.md exists but missing claude-mem section');
    }
  } else {
    console.log('Context: No GEMINI.md found');
  }

  // Check extension installation
  const extManifestPath = path.join(GEMINI_EXTENSION_DIR, 'gemini-extension.json');
  if (existsSync(extManifestPath)) {
    console.log(`Extension: Installed at ${GEMINI_EXTENSION_DIR}`);
    try {
      const manifest = JSON.parse(readFileSync(extManifestPath, 'utf-8'));
      if (manifest.mcpServers) {
        console.log(`  MCP servers: ${Object.keys(manifest.mcpServers).join(', ')}`);
      }
    } catch {
      // ignore parse errors
    }
    const extSkillsDir = path.join(GEMINI_EXTENSION_DIR, 'skills');
    if (existsSync(extSkillsDir)) {
      const skills = readdirSync(extSkillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && existsSync(path.join(extSkillsDir, d.name, 'SKILL.md')));
      console.log(`  Skills: ${skills.length} (${skills.map(s => s.name).join(', ')})`);
    }
  } else {
    console.log('Extension: Not installed');
  }

  console.log('');
  return 0;
}

/**
 * Handle gemini-cli subcommand for hooks management.
 */
export async function handleGeminiCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installGeminiCliHooks();

    case 'uninstall':
      return uninstallGeminiCliHooks();

    case 'status':
      return checkGeminiCliHooksStatus();

    default:
      console.log(`
Claude-Mem Gemini CLI Integration

Usage: claude-mem gemini-cli <command>

Commands:
  install             Install hooks into ~/.gemini/settings.json
  uninstall           Remove claude-mem hooks (preserves other hooks)
  status              Check installation status

Examples:
  claude-mem gemini-cli install     # Install hooks
  claude-mem gemini-cli status      # Check if installed
  claude-mem gemini-cli uninstall   # Remove hooks

For more info: https://docs.claude-mem.ai/usage/gemini-provider
      `);
      return 0;
  }
}
