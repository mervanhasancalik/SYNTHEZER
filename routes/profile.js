/**
 * Synthezer Profile Routes
 * Export/import user data and view profile stats
 */

import { Router } from 'express';
import express from 'express';
import { getDb } from '../lib/db.js';

const router = Router();

// Max import size: 50MB (enforced at JSON parse level)
const MAX_IMPORT_SIZE = 50 * 1024 * 1024;
const EXPORT_VERSION = 1;

/**
 * Profile stats overview
 * GET /api/profile/stats
 */
router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const pipelines = db.prepare('SELECT COUNT(*) as n FROM pipelines').get().n;
    const pipelinesComplete = db.prepare("SELECT COUNT(*) as n FROM pipelines WHERE status = 'complete'").get().n;
    const pipelinesDraft = pipelines - pipelinesComplete;

    const chipsTotal = db.prepare('SELECT COUNT(*) as n FROM chips').get().n;
    const chipCategories = db.prepare('SELECT category, COUNT(*) as n FROM chips GROUP BY category').all();

    const chipPacksTotal = db.prepare('SELECT COUNT(*) as n FROM chip_packs').get().n;
    const chipPacksDefault = db.prepare('SELECT COUNT(*) as n FROM chip_packs WHERE is_default = 1').get().n;
    const chipPacksCustom = chipPacksTotal - chipPacksDefault;

    const libraryEntries = db.prepare('SELECT COUNT(*) as n FROM library').get().n;
    const logEntries = db.prepare('SELECT COUNT(*) as n FROM pipeline_log').get().n;

    // Approximate DB file size (row counts as proxy)
    const totalRows = pipelines + chipsTotal + chipPacksTotal + libraryEntries + logEntries;

    res.json({
      success: true,
      stats: {
        pipelines: { total: pipelines, complete: pipelinesComplete, draft: pipelinesDraft },
        chips: { total: chipsTotal, byCategory: chipCategories },
        chipPacks: { total: chipPacksTotal, default: chipPacksDefault, custom: chipPacksCustom },
        library: { total: libraryEntries },
        activityLog: { total: logEntries },
        totalRows
      }
    });
  } catch (error) {
    console.error('[Profile] Stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load profile stats' });
  }
});

/**
 * Export profile data
 * GET /api/profile/export
 * Query: ?includeImages=true (optional, default false)
 */
router.get('/export', (req, res) => {
  try {
    const db = getDb();
    const includeImages = req.query.includeImages === 'true';

    // Dump all tables
    const pipelines = db.prepare('SELECT * FROM pipelines').all();
    let stage1 = db.prepare('SELECT * FROM stage1_input').all();
    const stage2 = db.prepare('SELECT * FROM stage2_understanding').all();
    const stage3 = db.prepare('SELECT * FROM stage3_research').all();
    const stage4 = db.prepare('SELECT * FROM stage4_implementation').all();
    const stage5 = db.prepare('SELECT * FROM stage5_output').all();
    const chips = db.prepare('SELECT * FROM chips').all();
    const chipPacks = db.prepare('SELECT * FROM chip_packs').all();
    const library = db.prepare('SELECT * FROM library').all();
    const pipelineLog = db.prepare('SELECT * FROM pipeline_log').all();

    // Strip base64 images unless opted in
    if (!includeImages) {
      stage1 = stage1.map(row => ({ ...row, images: '[]' }));
    }

    const exportData = {
      _synthezer_profile: true,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      counts: {
        pipelines: pipelines.length,
        chips: chips.length,
        chipPacks: chipPacks.length,
        library: library.length,
        logEntries: pipelineLog.length,
        imagesIncluded: includeImages
      },
      tables: {
        pipelines,
        stage1_input: stage1,
        stage2_understanding: stage2,
        stage3_research: stage3,
        stage4_implementation: stage4,
        stage5_output: stage5,
        chips,
        chip_packs: chipPacks,
        library,
        pipeline_log: pipelineLog
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="synthezer-profile-${Date.now()}.json"`);
    res.json(exportData);
  } catch (error) {
    console.error('[Profile] Export error:', error);
    res.status(500).json({ success: false, error: 'Failed to export profile' });
  }
});

/**
 * Import profile data
 * POST /api/profile/import
 * Body: { mode: 'merge' | 'replace', data: <export object> }
 */
router.post('/import', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { mode, data } = req.body;

    if (!data || !data._synthezer_profile) {
      return res.status(400).json({ success: false, error: 'Invalid profile file. Missing Synthezer signature.' });
    }
    if (!data.version || data.version > EXPORT_VERSION) {
      return res.status(400).json({ success: false, error: `Unsupported profile version: ${data.version}. This app supports version ${EXPORT_VERSION}.` });
    }
    if (!data.tables || typeof data.tables !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid profile file. No tables found.' });
    }
    if (mode !== 'merge' && mode !== 'replace') {
      return res.status(400).json({ success: false, error: 'Mode must be "merge" or "replace".' });
    }

    // Size check (rough estimate from JSON)
    const roughSize = JSON.stringify(data.tables).length;
    if (roughSize > MAX_IMPORT_SIZE) {
      return res.status(400).json({ success: false, error: `Profile too large (${Math.round(roughSize / 1024 / 1024)}MB). Max is 50MB.` });
    }

    const db = getDb();
    const tables = data.tables;
    const counts = { pipelines: 0, chips: 0, chipPacks: 0, library: 0, logEntries: 0 };

    const importTx = db.transaction(() => {
      // In replace mode, wipe everything first
      if (mode === 'replace') {
        db.prepare('DELETE FROM pipeline_log').run();
        db.prepare('DELETE FROM stage1_input').run();
        db.prepare('DELETE FROM stage2_understanding').run();
        db.prepare('DELETE FROM stage3_research').run();
        db.prepare('DELETE FROM stage4_implementation').run();
        db.prepare('DELETE FROM stage5_output').run();
        db.prepare('DELETE FROM library').run();
        db.prepare('DELETE FROM pipelines').run();
        db.prepare('DELETE FROM chips').run();
        db.prepare('DELETE FROM chip_packs').run();
      }

      // Import pipelines
      if (Array.isArray(tables.pipelines)) {
        const stmt = db.prepare(`
          INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO pipelines
          (id, name, description, focus_tags, current_stage, status, locked_gates, ai_model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of tables.pipelines) {
          if (!r.id || typeof r.id !== 'string') continue;
          stmt.run(r.id, str(r.name), str(r.description), str(r.focus_tags),
            int(r.current_stage, 1), str(r.status, 'draft'), str(r.locked_gates, '[]'),
            r.ai_model || null, int(r.created_at), int(r.updated_at));
          counts.pipelines++;
        }
      }

      // Import stage tables (only for pipelines that exist)
      importStageTable(db, mode, tables.stage1_input, 'stage1_input',
        ['pipeline_id', 'prompt', 'ai_mind', 'prerequisites', 'implementation_area', 'tools', 'no_go_rules', 'images', 'submitted_at'],
        r => [r.pipeline_id, str(r.prompt), str(r.ai_mind, '[]'), str(r.prerequisites, '[]'),
          str(r.implementation_area, '[]'), str(r.tools, '[]'), str(r.no_go_rules, '[]'),
          str(r.images, '[]'), r.submitted_at || null]);

      importStageTable(db, mode, tables.stage2_understanding, 'stage2_understanding',
        ['pipeline_id', 'status', 'ai_questions', 'user_answers', 'communication_log', 'master_prompt', 'completed_at'],
        r => [r.pipeline_id, str(r.status, 'pending'), str(r.ai_questions, '[]'),
          r.user_answers || null, str(r.communication_log, '[]'), r.master_prompt || null, r.completed_at || null]);

      importStageTable(db, mode, tables.stage3_research, 'stage3_research',
        ['pipeline_id', 'status', 'ai_research_question', 'research_areas', 'user_research_answer', 'research_master_guide', 'communication_log', 'completed_at'],
        r => [r.pipeline_id, str(r.status, 'pending'), r.ai_research_question || null,
          str(r.research_areas, '[]'), r.user_research_answer || null, r.research_master_guide || null,
          str(r.communication_log, '[]'), r.completed_at || null]);

      importStageTable(db, mode, tables.stage4_implementation, 'stage4_implementation',
        ['pipeline_id', 'status', 'implementation_plan', 'implementation_notes', 'ai_feedback', 'user_feedback', 'verification_checklist', 'subagent_tasks', 'completed_at'],
        r => [r.pipeline_id, str(r.status, 'pending'), r.implementation_plan || null,
          r.implementation_notes || null, r.ai_feedback || null, r.user_feedback || null,
          str(r.verification_checklist, '{}'), str(r.subagent_tasks, '[]'), r.completed_at || null]);

      importStageTable(db, mode, tables.stage5_output, 'stage5_output',
        ['pipeline_id', 'output_short', 'output_detailed', 'pae_accuracy', 'pae_completeness', 'pae_confidence', 'pae_comments', 'pae_generated_at', 'completed_at'],
        r => [r.pipeline_id, r.output_short || null, r.output_detailed || null,
          r.pae_accuracy ?? null, r.pae_completeness ?? null, r.pae_confidence ?? null,
          r.pae_comments || null, r.pae_generated_at || null, r.completed_at || null]);

      // Import chips
      if (Array.isArray(tables.chips)) {
        const stmt = db.prepare(`
          INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO chips
          (category, name, description, usage_count, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const r of tables.chips) {
          if (!r.category || !r.name) continue;
          stmt.run(str(r.category), str(r.name), str(r.description), int(r.usage_count, 0), int(r.created_at));
          counts.chips++;
        }
      }

      // Import chip packs
      if (Array.isArray(tables.chip_packs)) {
        const stmt = db.prepare(`
          INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO chip_packs
          (name, chips, is_default, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const r of tables.chip_packs) {
          if (!r.name) continue;
          stmt.run(str(r.name), str(r.chips, '{}'), r.is_default ? 1 : 0, int(r.created_at));
          counts.chipPacks++;
        }
      }

      // Import library
      if (Array.isArray(tables.library)) {
        const stmt = db.prepare(`
          INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO library
          (pipeline_id, name, model, final_stage, pae_score, status, archived_at, snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of tables.library) {
          stmt.run(r.pipeline_id || null, str(r.name), r.model || null,
            r.final_stage ?? null, r.pae_score ?? null, str(r.status),
            int(r.archived_at), r.snapshot || null);
          counts.library++;
        }
      }

      // Import pipeline log
      if (Array.isArray(tables.pipeline_log)) {
        const stmt = db.prepare(`
          INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO pipeline_log
          (pipeline_id, event, message, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const r of tables.pipeline_log) {
          if (!r.pipeline_id) continue;
          stmt.run(r.pipeline_id, str(r.event), str(r.message), int(r.created_at));
          counts.logEntries++;
        }
      }
    });

    importTx();

    res.json({ success: true, mode, counts });
  } catch (error) {
    console.error('[Profile] Import error:', error);
    res.status(500).json({ success: false, error: 'Import failed. Please check the file format and try again.' });
  }
});

// ── Helpers ──

function str(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val);
}

function int(val, fallback = 0) {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function importStageTable(db, mode, rows, tableName, columns, mapper) {
  if (!Array.isArray(rows)) return;
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(`
    INSERT OR ${mode === 'replace' ? 'ABORT' : 'IGNORE'} INTO ${tableName}
    (${columns.join(', ')}) VALUES (${placeholders})
  `);
  for (const r of rows) {
    if (!r.pipeline_id) continue;
    stmt.run(...mapper(r));
  }
}

export default router;
