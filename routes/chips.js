/**
 * Synthezer Chip Routes
 * Manage the user's chip library
 */

import { Router } from 'express';
import * as db from '../lib/db.js';

const router = Router();

/**
 * List all chips
 * GET /api/chips
 * Query: ?category=ai_mind (optional filter)
 */
router.get('/', (req, res) => {
  try {
    const { category } = req.query;
    const chips = db.getChips(category || null);

    // Group by category if no filter
    if (!category) {
      const grouped = {};
      chips.forEach(chip => {
        if (!grouped[chip.category]) grouped[chip.category] = [];
        grouped[chip.category].push(chip);
      });
      return res.json({ success: true, chips: grouped });
    }

    res.json({ success: true, chips });
  } catch (error) {
    console.error('[Chips] List error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Create or update chip
 * POST /api/chips
 * Body: { category, name, description }
 */
router.post('/', (req, res) => {
  try {
    const { category, name, description } = req.body;

    if (!category || !name) {
      return res.status(400).json({ success: false, error: 'Category and name are required' });
    }

    const validCategories = ['ai_mind', 'prerequisite', 'implementation', 'tools', 'no_go'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    if (name.length > 100) return res.status(400).json({ success: false, error: 'Chip name too long (max 100 chars)' });
    if (description && description.length > 1000) return res.status(400).json({ success: false, error: 'Description too long (max 1000 chars)' });

    const chip = db.upsertChip(category, name, description || '');
    res.json({ success: true, chip });
  } catch (error) {
    console.error('[Chips] Create error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Bulk import chips (for migrating from localStorage)
 * POST /api/chips/import
 * Body: { chips: { category: [{ name, description }] } }
 */
router.post('/import', (req, res) => {
  try {
    const { chips } = req.body;

    if (!chips || typeof chips !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid chips data' });
    }

    const validCategories = ['ai_mind', 'prerequisite', 'implementation', 'tools', 'no_go'];
    let imported = 0;

    for (const [category, chipList] of Object.entries(chips)) {
      if (!validCategories.includes(category)) continue; // Skip invalid categories
      if (Array.isArray(chipList)) {
        for (const chip of chipList) {
          if (chip.name && chip.name.length <= 100) {
            db.upsertChip(category, chip.name, (chip.description || '').slice(0, 1000));
            imported++;
          }
        }
      }
    }

    res.json({ success: true, imported });
  } catch (error) {
    console.error('[Chips] Import error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Chip Packs (must be before generic /:id routes) ──

/**
 * List all chip packs
 * GET /api/chips/packs
 */
router.get('/packs', (req, res) => {
  try {
    const packs = db.getChipPacks();
    res.json({ success: true, packs });
  } catch (error) {
    console.error('[Chips] List packs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Create a chip pack
 * POST /api/chips/packs
 * Body: { name, chips: { ai_mind: [...], ... } }
 */
router.post('/packs', (req, res) => {
  try {
    const { name, chips } = req.body;
    if (!name || !chips || typeof chips !== 'object') {
      return res.status(400).json({ success: false, error: 'Name and chips are required' });
    }
    const pack = db.createChipPack(name, chips);
    res.json({ success: true, pack });
  } catch (error) {
    if (error.message?.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'A pack with that name already exists' });
    }
    console.error('[Chips] Create pack error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Update a chip pack
 * PUT /api/chips/packs/:id
 * Body: { name, chips }
 */
router.put('/packs/:id', (req, res) => {
  try {
    const { name, chips } = req.body;
    if (!name || !chips) {
      return res.status(400).json({ success: false, error: 'Name and chips are required' });
    }
    const pack = db.updateChipPack(parseInt(req.params.id), name, chips);
    res.json({ success: true, pack });
  } catch (error) {
    if (error.message?.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'A pack with that name already exists' });
    }
    console.error('[Chips] Update pack error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Delete a chip pack (non-default only)
 * DELETE /api/chips/packs/:id
 */
router.delete('/packs/:id', (req, res) => {
  try {
    db.deleteChipPack(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('[Chips] Delete pack error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Reset default chip packs to original names and chip selections
 * POST /api/chips/reset-packs
 */
router.post('/reset-packs', (req, res) => {
  try {
    db.resetDefaultChipPacks();
    res.json({ success: true });
  } catch (error) {
    console.error('[Chips] Reset packs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Reset all chip usage counts to zero
 * POST /api/chips/reset-usage
 */
router.post('/reset-usage', (req, res) => {
  try {
    db.resetChipUsageCounts();
    res.json({ success: true });
  } catch (error) {
    console.error('[Chips] Reset usage error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Generic chip routes (must be AFTER specific /packs routes) ──

/**
 * Update chip
 * PUT /api/chips/:id
 */
router.put('/:id', (req, res) => {
  try {
    const { description } = req.body;
    const db2 = db.getDb();

    db2.prepare(`UPDATE chips SET description = ? WHERE id = ?`).run(description || '', req.params.id);

    const chip = db2.prepare(`SELECT * FROM chips WHERE id = ?`).get(req.params.id);
    res.json({ success: true, chip });
  } catch (error) {
    console.error('[Chips] Update error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Delete chip
 * DELETE /api/chips/:id
 */
router.delete('/:id', (req, res) => {
  try {
    db.deleteChip(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('[Chips] Delete error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
