/**
 * Synthezer Database Module
 * Local SQLite storage using better-sqlite3
 */

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', 'db', 'synthezer.db');
const require = createRequire(import.meta.url);

function migrateLegacyDb(legacyPath, newPath) {
  if (existsSync(newPath)) return newPath;
  if (existsSync(legacyPath)) {
    try {
      mkdirSync(dirname(newPath), { recursive: true });
      copyFileSync(legacyPath, newPath);
      return newPath;
    } catch {
      return legacyPath;
    }
  }
  return newPath;
}

function resolveDbPath() {
  const envPath = process.env.SYNTHEZER_DB_PATH || process.env.CLAWZER_DB_PATH;
  if (envPath && !envPath.includes('app.asar')) {
    if (envPath.toLowerCase().endsWith('synthezer.db')) {
      const legacyEnvPath = envPath.replace(/synthezer\.db$/i, 'clawzer.db');
      return migrateLegacyDb(legacyEnvPath, envPath);
    }
    return envPath;
  }
  
  // Try Electron userData if available
  try {
    const electron = require('electron');
    if (electron?.app?.getPath) {
      const base = electron.app.getPath('userData');
      const legacyPath = join(base, 'clawzer.db');
      const newPath = join(base, 'synthezer.db');
      return migrateLegacyDb(legacyPath, newPath);
    }
  } catch {
    // Not running under Electron
  }
  
  // Fallback to OS user data directory
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir();
  const legacyPath = join(base, 'ClawZer', 'clawzer.db');
  const newPath = join(base, 'Synthezer', 'synthezer.db');
  return migrateLegacyDb(legacyPath, newPath);
}

const DB_PATH = resolveDbPath() || DEFAULT_DB_PATH;
const SCHEMA_PATH = join(__dirname, '..', 'db', 'schema.sql');

let db = null;

/**
 * Initialize database connection and run schema
 */
export function initDb() {
  if (db) return db;
  
  // Ensure database directory exists (important for packaged apps)
  const dbDir = dirname(DB_PATH);
  mkdirSync(dbDir, { recursive: true });
  
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // Run schema
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  
  // Migrate chip names: underscores → spaces (must run before seed)
  migrateChipNamesToSpaces();

  // Seed default chips if empty
  seedChipsIfEmpty();

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

/**
 * Get database instance
 */
export function getDb() {
  if (!db) initDb();
  return db;
}

/**
 * Seed default chip libraries if the chips table is empty
 */
export function seedChipsIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM chips').get().c;
  
  const seedPath = join(__dirname, '..', 'db', 'chips.seed.json');
  let seed;
  try {
    const raw = readFileSync(seedPath, 'utf-8').replace(/^\uFEFF/, '');
    seed = JSON.parse(raw);
  } catch (e) {
    console.warn('[DB] No chip seed file found or invalid JSON:', e.message);
    return false;
  }
  
  const stmt = db.prepare(`
    INSERT INTO chips (category, name, description)
    VALUES (?, ?, ?)
    ON CONFLICT(category, name) DO NOTHING
  `);
  
  for (const [category, chips] of Object.entries(seed)) {
    if (!Array.isArray(chips)) continue;
    for (const chip of chips) {
      if (!chip?.name) continue;
      stmt.run(category, chip.name.toUpperCase(), chip.description || '');
    }
  }
  
  if (!count || count === 0) {
    console.log('[DB] Seeded default chip libraries');
  } else {
    console.log('[DB] Added any missing default chips');
  }
  return true;
}

/**
 * Migrate chip names from underscores to spaces (idempotent).
 * Handles three cases:
 *  - Fresh install: no underscores to migrate
 *  - Existing install: renames underscore chips to space chips
 *  - Mixed state: both versions exist (deletes old underscore duplicates)
 */
function migrateChipNamesToSpaces() {
  const db = getDb();
  const migrate = db.transaction(() => {
    // Remove old underscore-named chips where the space-named version already exists
    db.prepare(`
      DELETE FROM chips WHERE rowid IN (
        SELECT old.rowid FROM chips old
        JOIN chips new ON old.category = new.category
          AND REPLACE(old.name, '_', ' ') = new.name
          AND old.name != new.name
        WHERE old.name LIKE '%!_%' ESCAPE '!'
      )
    `).run();

    // Rename any remaining underscore chips that don't have a space equivalent
    const result = db.prepare(
      `UPDATE chips SET name = REPLACE(name, '_', ' ') WHERE name LIKE '%!_%' ESCAPE '!'`
    ).run();
    if (result.changes > 0) {
      console.log(`[DB] Migrated ${result.changes} chip names: underscores → spaces`);
    }

    // Update chip names stored in pipeline stage1_input JSON
    db.prepare(`
      UPDATE stage1_input SET
        ai_mind = REPLACE(ai_mind, '_', ' '),
        prerequisites = REPLACE(prerequisites, '_', ' '),
        implementation_area = REPLACE(implementation_area, '_', ' '),
        tools = REPLACE(tools, '_', ' '),
        no_go_rules = REPLACE(no_go_rules, '_', ' ')
      WHERE ai_mind LIKE '%!_%' ESCAPE '!'
         OR prerequisites LIKE '%!_%' ESCAPE '!'
         OR implementation_area LIKE '%!_%' ESCAPE '!'
         OR tools LIKE '%!_%' ESCAPE '!'
         OR no_go_rules LIKE '%!_%' ESCAPE '!'
    `).run();
  });
  migrate();
}

/**
 * Generate a cryptographically secure unique pipeline ID
 */
export function generateId() {
  const id = crypto.randomBytes(9).toString('base64url').slice(0, 12).toLowerCase();
  return `pl_${id}_${Date.now().toString(36)}`;
}

// ═══════════════════════════════════════
// PIPELINE OPERATIONS
// ═══════════════════════════════════════

/**
 * Create a new pipeline
 */
export function createPipeline(name = 'Untitled Pipeline', aiModel = null, description = '', focusTags = '') {
  const db = getDb();
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    INSERT INTO pipelines (id, name, description, focus_tags, ai_model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description || '', focusTags || '', aiModel, now, now);
  
  // Initialize all stage tables
  db.prepare(`INSERT INTO stage1_input (pipeline_id, prompt) VALUES (?, '')`).run(id);
  db.prepare(`INSERT INTO stage2_understanding (pipeline_id) VALUES (?)`).run(id);
  db.prepare(`INSERT INTO stage3_research (pipeline_id) VALUES (?)`).run(id);
  db.prepare(`INSERT INTO stage4_implementation (pipeline_id) VALUES (?)`).run(id);
  db.prepare(`INSERT INTO stage5_output (pipeline_id) VALUES (?)`).run(id);
  
  return getPipeline(id);
}

/**
 * Get pipeline with all stage data
 */
export function getPipeline(id) {
  const db = getDb();
  
  const pipeline = db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id);
  if (!pipeline) return null;
  
  const stage1 = db.prepare(`SELECT * FROM stage1_input WHERE pipeline_id = ?`).get(id);
  const stage2 = db.prepare(`SELECT * FROM stage2_understanding WHERE pipeline_id = ?`).get(id);
  const stage3 = db.prepare(`SELECT * FROM stage3_research WHERE pipeline_id = ?`).get(id);
  const stage4 = db.prepare(`SELECT * FROM stage4_implementation WHERE pipeline_id = ?`).get(id);
  const stage5 = db.prepare(`SELECT * FROM stage5_output WHERE pipeline_id = ?`).get(id);
  const log = db.prepare(`SELECT event, message, created_at FROM pipeline_log WHERE pipeline_id = ? ORDER BY created_at ASC`).all(id);
  
  // Parse JSON fields
  const parseJson = (val, fallback = []) => {
    try { return JSON.parse(val || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  
  return {
    ...pipeline,
    locked_gates: parseJson(pipeline.locked_gates, []),
    stage1: stage1 ? {
      ...stage1,
      ai_mind: parseJson(stage1.ai_mind),
      prerequisites: parseJson(stage1.prerequisites),
      implementation_area: parseJson(stage1.implementation_area),
      tools: parseJson(stage1.tools),
      no_go_rules: parseJson(stage1.no_go_rules),
      images: parseJson(stage1.images),
    } : null,
    stage2: stage2 ? {
      ...stage2,
      ai_questions: parseJson(stage2.ai_questions),
      communication_log: parseJson(stage2.communication_log),
    } : null,
    stage3: stage3 ? {
      ...stage3,
      research_areas: parseJson(stage3.research_areas),
      communication_log: parseJson(stage3.communication_log),
    } : null,
    stage4: stage4 ? {
      ...stage4,
      verification_checklist: parseJson(stage4.verification_checklist, {}),
      subagent_tasks: parseJson(stage4.subagent_tasks),
    } : null,
    stage5: stage5 || null,
    log: log || [],
  };
}

/**
 * Add an activity log entry for a pipeline
 */
export function addPipelineLog(pipelineId, event, message = '') {
  const db = getDb();
  db.prepare(`INSERT INTO pipeline_log (pipeline_id, event, message) VALUES (?, ?, ?)`).run(pipelineId, event, message);
}

/**
 * List all pipelines (summary)
 */
export function listPipelines(status = null, limit = 50) {
  const db = getDb();
  
  let query = `SELECT id, name, current_stage, status, ai_model, created_at, updated_at FROM pipelines`;
  const params = [];
  
  if (status) {
    query += ` WHERE status = ?`;
    params.push(status);
  }
  
  query += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);
  
  return db.prepare(query).all(...params);
}

/**
 * Update pipeline metadata
 */
export function updatePipeline(id, updates) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  const allowed = ['name', 'current_stage', 'status', 'locked_gates', 'ai_model'];
  const sets = [];
  const values = [];
  
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(typeof val === 'object' ? JSON.stringify(val) : val);
    }
  }
  
  if (sets.length === 0) {
    // Just update timestamp
    db.prepare(`UPDATE pipelines SET updated_at = ? WHERE id = ?`).run(now, id);
    return true;
  }
  
  sets.push('updated_at = ?');
  values.push(now, id);
  
  db.prepare(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

/**
 * Delete pipeline and all related data
 */
export function deletePipeline(id) {
  const db = getDb();
  db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  return true;
}

// ═══════════════════════════════════════
// STAGE 1 OPERATIONS
// ═══════════════════════════════════════

/**
 * Save Stage 1 input data
 */
export function saveStage1(pipelineId, data) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    UPDATE stage1_input SET
      prompt = ?,
      ai_mind = ?,
      prerequisites = ?,
      implementation_area = ?,
      tools = ?,
      no_go_rules = ?,
      images = ?,
      submitted_at = ?
    WHERE pipeline_id = ?
  `).run(
    data.prompt || '',
    JSON.stringify(data.ai_mind || []),
    JSON.stringify(data.prerequisites || []),
    JSON.stringify(data.implementation_area || []),
    JSON.stringify(data.tools || []),
    JSON.stringify(data.no_go_rules || []),
    JSON.stringify(data.images || []),
    now,
    pipelineId
  );
  
  // Update pipeline timestamp
  updatePipeline(pipelineId, {});
  
  return true;
}

// ═══════════════════════════════════════
// STAGE 2 OPERATIONS
// ═══════════════════════════════════════

/**
 * Save Stage 2 AI response
 */
export function saveStage2AiResponse(pipelineId, status, questions, masterPrompt = null) {
  const db = getDb();
  
  db.prepare(`
    UPDATE stage2_understanding SET
      status = ?,
      ai_questions = ?,
      master_prompt = ?
    WHERE pipeline_id = ?
  `).run(
    status,
    JSON.stringify(questions || []),
    masterPrompt,
    pipelineId
  );
  
  return true;
}

/**
 * Save Stage 2 user answers
 */
export function saveStage2UserAnswer(pipelineId, answer) {
  const db = getDb();
  
  // Get current log
  const stage2 = db.prepare(`SELECT communication_log FROM stage2_understanding WHERE pipeline_id = ?`).get(pipelineId);
  const log = JSON.parse(stage2?.communication_log || '[]');
  
  // Add to log
  log.push({
    role: 'user',
    content: answer,
    timestamp: Date.now()
  });
  
  db.prepare(`
    UPDATE stage2_understanding SET
      user_answers = ?,
      communication_log = ?,
      status = 'answered'
    WHERE pipeline_id = ?
  `).run(answer, JSON.stringify(log), pipelineId);
  
  return true;
}

/**
 * Complete Stage 2 with master prompt
 */
export function completeStage2(pipelineId, masterPrompt) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    UPDATE stage2_understanding SET
      status = 'confirmed',
      master_prompt = ?,
      completed_at = ?
    WHERE pipeline_id = ?
  `).run(masterPrompt, now, pipelineId);
  
  return true;
}

// ═══════════════════════════════════════
// STAGE 3 OPERATIONS
// ═══════════════════════════════════════

/**
 * Save Stage 3 AI research question and areas
 */
export function saveStage3AiResponse(pipelineId, researchQuestion, researchAreas, initialObservations) {
  const db = getDb();
  
  // Add to communication log
  const stage3 = db.prepare(`SELECT communication_log FROM stage3_research WHERE pipeline_id = ?`).get(pipelineId);
  const log = JSON.parse(stage3?.communication_log || '[]');
  log.push({
    role: 'assistant',
    content: initialObservations || researchQuestion,
    timestamp: Date.now()
  });
  
  db.prepare(`
    UPDATE stage3_research SET
      status = 'questioning',
      ai_research_question = ?,
      research_areas = ?,
      communication_log = ?
    WHERE pipeline_id = ?
  `).run(
    researchQuestion,
    JSON.stringify(researchAreas || []),
    JSON.stringify(log),
    pipelineId
  );
  
  return true;
}

/**
 * Save Stage 3 user research answer
 */
export function saveStage3UserAnswer(pipelineId, answer) {
  const db = getDb();
  
  // Get current log
  const stage3 = db.prepare(`SELECT communication_log FROM stage3_research WHERE pipeline_id = ?`).get(pipelineId);
  const log = JSON.parse(stage3?.communication_log || '[]');
  
  // Add to log
  log.push({
    role: 'user',
    content: answer,
    timestamp: Date.now()
  });
  
  db.prepare(`
    UPDATE stage3_research SET
      user_research_answer = ?,
      communication_log = ?,
      status = 'answered'
    WHERE pipeline_id = ?
  `).run(answer, JSON.stringify(log), pipelineId);
  
  return true;
}

/**
 * Complete Stage 3 with research master guide
 */
export function completeStage3(pipelineId, researchMasterGuide) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  // Add to communication log
  const stage3 = db.prepare(`SELECT communication_log FROM stage3_research WHERE pipeline_id = ?`).get(pipelineId);
  const log = JSON.parse(stage3?.communication_log || '[]');
  log.push({
    role: 'assistant',
    content: 'Research synthesis complete. Master Guide ready.',
    timestamp: Date.now()
  });
  
  db.prepare(`
    UPDATE stage3_research SET
      status = 'complete',
      research_master_guide = ?,
      communication_log = ?,
      completed_at = ?
    WHERE pipeline_id = ?
  `).run(researchMasterGuide, JSON.stringify(log), now, pipelineId);
  
  return true;
}

// ═══════════════════════════════════════
// STAGE 4 OPERATIONS
// ═══════════════════════════════════════

/**
 * Save Stage 4 implementation plan
 */
export function saveStage4Plan(pipelineId, implementationNotes, verificationChecklist, readyToDeploy, question) {
  const db = getDb();
  
  db.prepare(`
    UPDATE stage4_implementation SET
      status = ?,
      implementation_notes = ?,
      verification_checklist = ?,
      ai_feedback = ?
    WHERE pipeline_id = ?
  `).run(
    readyToDeploy ? 'ready' : 'needs_input',
    implementationNotes,
    JSON.stringify(verificationChecklist || {}),
    question,
    pipelineId
  );
  
  return true;
}

/**
 * Save Stage 4 user feedback
 */
export function saveStage4UserFeedback(pipelineId, feedback) {
  const db = getDb();
  
  db.prepare(`
    UPDATE stage4_implementation SET
      user_feedback = ?,
      status = 'feedback_received'
    WHERE pipeline_id = ?
  `).run(feedback, pipelineId);
  
  return true;
}

/**
 * Mark Stage 4 as deploying
 */
export function markStage4Deploying(pipelineId) {
  const db = getDb();
  
  db.prepare(`
    UPDATE stage4_implementation SET status = 'deploying' WHERE pipeline_id = ?
  `).run(pipelineId);
  
  return true;
}

/**
 * Complete Stage 4 with implementation plan
 */
export function completeStage4(pipelineId, implementationPlan) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    UPDATE stage4_implementation SET
      status = 'complete',
      implementation_plan = ?,
      completed_at = ?
    WHERE pipeline_id = ?
  `).run(implementationPlan, now, pipelineId);
  
  return true;
}

// ═══════════════════════════════════════
// STAGE 5 OPERATIONS
// ═══════════════════════════════════════

/**
 * Save Stage 5 output
 */
export function saveStage5Output(pipelineId, outputShort, outputDetailed, implementationNotes) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    UPDATE stage5_output SET
      output_short = ?,
      output_detailed = ?,
      completed_at = ?
    WHERE pipeline_id = ?
  `).run(outputShort, outputDetailed, now, pipelineId);
  
  // Also store implementation notes in stage4
  if (implementationNotes) {
    db.prepare(`
      UPDATE stage4_implementation SET ai_feedback = ? WHERE pipeline_id = ?
    `).run(implementationNotes, pipelineId);
  }
  
  return true;
}

/**
 * Save PAE scores
 */
export function savePAE(pipelineId, accuracy, completeness, confidence, comments) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    UPDATE stage5_output SET
      pae_accuracy = ?,
      pae_completeness = ?,
      pae_confidence = ?,
      pae_comments = ?,
      pae_generated_at = ?
    WHERE pipeline_id = ?
  `).run(accuracy, completeness, confidence, comments, now, pipelineId);
  
  // Update pipeline status
  updatePipeline(pipelineId, { status: 'complete' });
  
  return true;
}

// ═══════════════════════════════════════
// CHIP OPERATIONS
// ═══════════════════════════════════════

/**
 * Get all chips, optionally filtered by category
 */
export function getChips(category = null) {
  const db = getDb();
  
  if (category) {
    return db.prepare(`SELECT * FROM chips WHERE category = ? ORDER BY usage_count DESC, name`).all(category);
  }
  return db.prepare(`SELECT * FROM chips ORDER BY category, usage_count DESC, name`).all();
}

/**
 * Get chip by name and category
 */
export function getChip(category, name) {
  const db = getDb();
  return db.prepare(`SELECT * FROM chips WHERE category = ? AND name = ?`).get(category, name);
}

/**
 * Create or update chip
 */
export function upsertChip(category, name, description) {
  const db = getDb();
  
  db.prepare(`
    INSERT INTO chips (category, name, description)
    VALUES (?, ?, ?)
    ON CONFLICT(category, name) DO UPDATE SET description = ?
  `).run(category, name.toUpperCase(), description, description);
  
  return getChip(category, name.toUpperCase());
}

/**
 * Delete chip
 */
export function deleteChip(id) {
  const db = getDb();
  db.prepare(`DELETE FROM chips WHERE id = ?`).run(id);
  return true;
}

/**
 * Increment chip usage count
 */
export function incrementChipUsage(category, name) {
  const db = getDb();
  db.prepare(`UPDATE chips SET usage_count = usage_count + 1 WHERE category = ? AND name = ?`).run(category, name);
}

/**
 * Reset all chip usage counts to zero
 */
export function resetChipUsageCounts() {
  const db = getDb();
  db.prepare(`UPDATE chips SET usage_count = 0`).run();
}

/**
 * Resolve chip names to full definitions
 */
export function resolveChips(category, names) {
  const db = getDb();
  if (!names || names.length === 0) return [];
  
  const placeholders = names.map(() => '?').join(',');
  return db.prepare(`
    SELECT name, description FROM chips 
    WHERE category = ? AND name IN (${placeholders})
  `).all(category, ...names);
}

// ── Chip Packs ──

const DEFAULT_CHIP_PACKS = [
  {
    name: 'Core Productivity',
    chips: {
      ai_mind: ['PRECISION', 'CLARITY FIRST', 'ACTION ORIENTED'],
      prerequisite: ['ASK MISSING CONTEXT', 'DEFINE OUTPUT FORMAT'],
      implementation: ['SUMMARIZATION', 'ACTION ITEMS'],
      tools: ['TEMPLATE APPLIER'],
      no_go: ['NO SPECULATION']
    }
  },
  {
    name: 'Engineering',
    chips: {
      ai_mind: ['CORRECTNESS FIRST', 'MINIMAL DIFF', 'SECURITY AWARE'],
      prerequisite: ['READ CODEBASE', 'IDENTIFY REQUIREMENTS', 'CHECK DEPENDENCIES'],
      implementation: ['CODE GEN', 'DEBUG', 'TESTS'],
      tools: ['TERMINAL', 'FILE SYSTEM', 'DIFF TOOL'],
      no_go: ['NO BREAKING CHANGES', 'NO UNSAFE IO']
    }
  },
  {
    name: 'Writing',
    chips: {
      ai_mind: ['STYLE AWARE', 'VOICE CONSISTENT', 'STRUCTURE DRIVEN'],
      prerequisite: ['GET BRIEF', 'EXTRACT KEY POINTS'],
      implementation: ['DRAFTING', 'EDITING', 'HEADLINE GEN'],
      tools: ['STYLE GUIDE', 'READABILITY'],
      no_go: ['NO PLAGIARISM', 'NO FABRICATION']
    }
  },
  {
    name: 'Research',
    chips: {
      ai_mind: ['EVIDENCE FIRST', 'MULTI VIEW', 'SCOPE CONTROL'],
      prerequisite: ['DEFINE QUESTION', 'REQUEST SOURCES', 'DEFINE SCOPE'],
      implementation: ['LIT REVIEW', 'COMPARISON', 'GAPS'],
      tools: ['BROWSER', 'CITATION TRACKER'],
      no_go: ['NO UNSOURCED CLAIMS', 'NO FAKE CITATIONS']
    }
  },
  {
    name: 'Support Agent',
    chips: {
      ai_mind: ['EMPATHETIC', 'PROCEDURAL', 'SAFETY FIRST', 'CONSISTENT POLICY'],
      prerequisite: ['CAPTURE DETAILS', 'IDENTIFY SEVERITY', 'CONFIRM ENVIRONMENT'],
      implementation: ['TROUBLESHOOT', 'RESOLUTION', 'FAQ ENTRY', 'ESCALATION'],
      tools: ['LOG PARSER', 'KNOWLEDGE BASE', 'SCREENSHOT READER'],
      no_go: ['NO UNVERIFIED FIXES', 'NO PRIVACY RISK']
    }
  }
];

/**
 * Seed default chip packs if none exist
 */
export function seedChipPacksIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM chip_packs').get().n;
  if (count > 0) return;

  const insert = db.prepare('INSERT OR IGNORE INTO chip_packs (name, chips, is_default) VALUES (?, ?, 1)');
  const tx = db.transaction(() => {
    for (const pack of DEFAULT_CHIP_PACKS) {
      insert.run(pack.name, JSON.stringify(pack.chips));
    }
  });
  tx();
  console.log(`[DB] Seeded ${DEFAULT_CHIP_PACKS.length} default chip packs`);
}

/**
 * Get all chip packs
 */
export function getChipPacks() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM chip_packs ORDER BY is_default DESC, name').all();
  return rows.map(r => ({ ...r, chips: JSON.parse(r.chips || '{}') }));
}

/**
 * Get a single chip pack by ID
 */
export function getChipPack(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM chip_packs WHERE id = ?').get(id);
  if (row) row.chips = JSON.parse(row.chips || '{}');
  return row;
}

/**
 * Create a new chip pack
 */
export function createChipPack(name, chips) {
  const db = getDb();
  const result = db.prepare('INSERT INTO chip_packs (name, chips) VALUES (?, ?)').run(name, JSON.stringify(chips));
  return getChipPack(result.lastInsertRowid);
}

/**
 * Update a chip pack
 */
export function updateChipPack(id, name, chips) {
  const db = getDb();
  db.prepare('UPDATE chip_packs SET name = ?, chips = ? WHERE id = ?').run(name, JSON.stringify(chips), id);
  return getChipPack(id);
}

/**
 * Delete a chip pack (only non-default ones)
 */
export function deleteChipPack(id) {
  const db = getDb();
  db.prepare('DELETE FROM chip_packs WHERE id = ? AND is_default = 0').run(id);
  return true;
}

/**
 * Reset all default chip packs to their original names and chip selections
 */
export function resetDefaultChipPacks() {
  const db = getDb();
  const update = db.prepare('UPDATE chip_packs SET name = ?, chips = ? WHERE id = ? AND is_default = 1');
  const existing = db.prepare('SELECT id, name FROM chip_packs WHERE is_default = 1 ORDER BY id').all();

  const tx = db.transaction(() => {
    // Reset existing default packs in order (they were seeded sequentially)
    for (let i = 0; i < existing.length && i < DEFAULT_CHIP_PACKS.length; i++) {
      update.run(DEFAULT_CHIP_PACKS[i].name, JSON.stringify(DEFAULT_CHIP_PACKS[i].chips), existing[i].id);
    }
    // If some default packs were deleted, re-insert them
    if (existing.length < DEFAULT_CHIP_PACKS.length) {
      const insert = db.prepare('INSERT OR IGNORE INTO chip_packs (name, chips, is_default) VALUES (?, ?, 1)');
      for (let i = existing.length; i < DEFAULT_CHIP_PACKS.length; i++) {
        insert.run(DEFAULT_CHIP_PACKS[i].name, JSON.stringify(DEFAULT_CHIP_PACKS[i].chips));
      }
    }
  });
  tx();
  console.log('[DB] Reset default chip packs to original values');
}

export default {
  initDb,
  getDb,
  seedChipsIfEmpty,
  seedChipPacksIfEmpty,
  generateId,
  createPipeline,
  getPipeline,
  listPipelines,
  updatePipeline,
  deletePipeline,
  addPipelineLog,
  saveStage1,
  saveStage2AiResponse,
  saveStage2UserAnswer,
  completeStage2,
  saveStage3AiResponse,
  saveStage3UserAnswer,
  completeStage3,
  saveStage4Plan,
  saveStage4UserFeedback,
  markStage4Deploying,
  completeStage4,
  saveStage5Output,
  savePAE,
  getChips,
  getChip,
  upsertChip,
  deleteChip,
  incrementChipUsage,
  resetChipUsageCounts,
  resolveChips,
  getChipPacks,
  getChipPack,
  createChipPack,
  updateChipPack,
  deleteChipPack,
  resetDefaultChipPacks,
};

