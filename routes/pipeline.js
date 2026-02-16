/**
 * Synthezer Pipeline Routes
 * Handles pipeline CRUD and gate processing
 */

import { Router } from 'express';
import * as db from '../lib/db.js';
import * as ai from '../lib/ai.js';
import * as prompts from '../lib/prompts.js';

const router = Router();

function chipNameValue(item) {
  return typeof item === 'string' ? item : item?.name;
}

/**
 * Extract a short error code and a user-facing hint from AI/gateway errors.
 * Returns { code, hint } where code is short (e.g. "HTTP 405") and hint
 * is a plain-language explanation of what happened and how to fix it.
 */
function getErrorDetails(error) {
  const msg = error?.message || '';

  // Errors from ai.js throwApiError() — already have .hint
  if (error.hint) {
    return { code: msg, hint: error.hint };
  }

  // Credential / config issues
  if (msg.includes('No AI credentials'))
    return { code: 'Not configured', hint: 'No AI connection set up. Open the AI settings (top-right menu) and connect to OpenClaw or a Local AI provider.' };
  if (msg.includes('gateway URL and token are required'))
    return { code: 'Missing credentials', hint: 'Gateway URL and token are missing. Open the AI settings and enter your OpenClaw connection details.' };
  if (msg.includes('Local AI URL is required'))
    return { code: 'Missing URL', hint: 'Local AI URL is missing. Open the AI settings and enter your local provider address.' };

  // Network errors
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED'))
    return { code: 'Connection failed', hint: 'Cannot connect to the AI server — it may be offline or the URL is wrong. Check that the server is running and the Gateway URL in AI settings is correct.' };
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo'))
    return { code: 'Server not found', hint: 'The Gateway URL hostname was not found. Double-check the URL in your AI settings.' };

  // Timeout
  if (msg.includes('timed out') || msg.includes('abort') || msg.includes('Timeout'))
    return { code: 'Timed out', hint: 'The AI request timed out — the model took too long to respond. Try again, or switch to a faster model in the AI settings.' };

  // JSON parse failures
  if (msg.includes('parse') || msg.includes('JSON'))
    return { code: 'Invalid response', hint: 'The AI returned an unexpected response format. This sometimes happens with certain models. Try again, or switch to a different model.' };

  // SSL / certificate errors
  if (msg.includes('certificate') || msg.includes('SSL') || msg.includes('TLS'))
    return { code: 'SSL error', hint: 'SSL/certificate error connecting to the AI server. If you are using a local server, try http:// instead of https:// in the Gateway URL.' };

  // Fallback
  return { code: 'Error', hint: msg || 'An unexpected error occurred. Check your AI settings and try again.' };
}

/**
 * Route AI request to either local AI or OpenClaw based on provided credentials
 */
async function sendAiRequest(req, pipeline, aiPrompt, images = [], fallbackKey = null) {
  const { local_ai_url, local_ai_model, gateway_url, gateway_token } = req.body;

  if (local_ai_url) {
    const model = local_ai_model || pipeline.ai_model || 'default';
    return ai.sendStructuredPromptLocal(local_ai_url, aiPrompt, model, images, fallbackKey);
  }

  if (gateway_url && gateway_token) {
    return ai.sendStructuredPrompt(gateway_url, gateway_token, aiPrompt, pipeline.ai_model || 'openclaw:main', images, fallbackKey);
  }

  throw new Error('No AI credentials provided — configure OpenClaw or Local AI');
}

// ═══════════════════════════════════════
// PIPELINE CRUD
// ═══════════════════════════════════════

/**
 * Create new pipeline
 * POST /api/pipeline
 */
router.post('/', (req, res) => {
  try {
    const { name, ai_model, description, focus_tags } = req.body;
    if (name && name.length > 200) return res.status(400).json({ success: false, error: 'Pipeline name too long (max 200 chars)' });
    if (description && description.length > 5000) return res.status(400).json({ success: false, error: 'Description too long (max 5000 chars)' });
    const pipeline = db.createPipeline(name, ai_model, description, focus_tags);
    db.addPipelineLog(pipeline.id, 'create', 'Pipeline created');
    res.json({ success: true, pipeline });
  } catch (error) {
    console.error('[Pipeline] Create error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * List pipelines
 * GET /api/pipeline
 */
router.get('/', (req, res) => {
  try {
    const { status, limit } = req.query;
    const parsedLimit = Math.min(parseInt(limit) || 50, 200);
    const pipelines = db.listPipelines(status, parsedLimit);
    res.json({ success: true, pipelines });
  } catch (error) {
    console.error('[Pipeline] List error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Get pipeline by ID
 * GET /api/pipeline/:id
 */
router.get('/:id', (req, res) => {
  try {
    const pipeline = db.getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    res.json({ success: true, pipeline });
  } catch (error) {
    console.error('[Pipeline] Get error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Update pipeline
 * PATCH /api/pipeline/:id
 */
router.patch('/:id', (req, res) => {
  try {
    const updated = db.updatePipeline(req.params.id, req.body);
    if (!updated) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }
    const pipeline = db.getPipeline(req.params.id);
    res.json({ success: true, pipeline });
  } catch (error) {
    console.error('[Pipeline] Update error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Delete pipeline
 * DELETE /api/pipeline/:id
 */
router.delete('/:id', (req, res) => {
  try {
    db.deletePipeline(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Pipeline] Delete error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════
// GATE 01: Stage 1 → Stage 2
// ═══════════════════════════════════════

/**
 * Submit Stage 1 and process Gate 01
 * POST /api/pipeline/:id/gate1
 */
router.post('/:id/gate1', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.locked_gates.includes(1)) {
      return res.status(400).json({ success: false, error: 'Gate 01 is already locked' });
    }
    
    const {
      prompt,
      ai_mind = [],
      prerequisites = [],
      implementation_area = [],
      tools = [],
      no_go_rules = [],
      gateway_url,
      gateway_token,
      local_ai_url
    } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    if (prompt && prompt.length > 100000) {
      return res.status(400).json({ success: false, error: 'Prompt too long (max 100000 chars)' });
    }

    const MAX_CHIPS = 50;
    const chipArrays = [ai_mind, prerequisites, implementation_area, tools, no_go_rules];
    for (const arr of chipArrays) {
      if (arr && arr.length > MAX_CHIPS) return res.status(400).json({ success: false, error: `Too many chips (max ${MAX_CHIPS} per category)` });
    }
    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }
    
    // Save Stage 1 data
    const stage1Data = {
      prompt: prompt.trim(),
      ai_mind,
      prerequisites,
      implementation_area,
      tools,
      no_go_rules
    };
    db.saveStage1(pipelineId, stage1Data);
    
    // Get chip definitions for context
    const allChips = db.getChips();
    
    // Build AI prompt
    const aiPrompt = prompts.buildStage2Prompt(stage1Data, allChips);
    
    console.log('[Gate01] Calling AI for pipeline:', pipelineId, 'with', (stage1Data.images?.length || 0), 'images');

    // Call AI (with images if provided)
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt, stage1Data.images || []);
    
    console.log('[Gate01] AI response status:', aiResponse.parsed?.status);
    
    // Save Stage 2 AI response
    const { status, questions, preliminary_understanding, master_prompt } = aiResponse.parsed;
    
    db.saveStage2AiResponse(
      pipelineId,
      status,
      questions || [],
      master_prompt || null
    );
    
    // Add to communication log (include both understanding AND questions so follow-up AI knows what was asked)
    const initialLogParts = [];
    if (preliminary_understanding) {
      initialLogParts.push(preliminary_understanding);
    }
    if (questions && questions.length > 0) {
      initialLogParts.push('Questions:\n' + questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
    }
    if (initialLogParts.length > 0) {
      const db2 = db.getDb();
      db2.prepare(`
        UPDATE stage2_understanding
        SET communication_log = ?
        WHERE pipeline_id = ?
      `).run(JSON.stringify([{
        role: 'assistant',
        content: initialLogParts.join('\n\n'),
        timestamp: Date.now()
      }]), pipelineId);
    }
    
    // Lock Gate 01 and advance to Stage 2
    const newLockedGates = [...pipeline.locked_gates, 1];
    db.updatePipeline(pipelineId, {
      current_stage: 2,
      locked_gates: newLockedGates,
      status: 'active'
    });
    
    db.addPipelineLog(pipelineId, 'gate1', 'Gate 01 processed — Stage 2 activated');
    
    // Increment chip usage counts
    [...ai_mind, ...prerequisites, ...implementation_area, ...tools, ...no_go_rules].forEach(item => {
      const name = chipNameValue(item);
      if (!name) return;
      const chip = allChips.find(c => c.name === name);
      if (chip) {
        db.incrementChipUsage(chip.category, chip.name);
      }
    });
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      stage: 2,
      status: aiResponse.parsed.status,
      ai_questions: aiResponse.parsed.questions || [],
      preliminary_understanding: aiResponse.parsed.preliminary_understanding || null,
      master_prompt: aiResponse.parsed.master_prompt || null,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Gate01] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

// ═══════════════════════════════════════
// STAGE 2: User Answer & Gate 02
// ═══════════════════════════════════════

/**
 * Submit user answer to AI questions
 * POST /api/pipeline/:id/stage2/answer
 */
router.post('/:id/stage2/answer', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 2) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 2' });
    }
    
    const { answer, gateway_url, gateway_token, local_ai_url } = req.body;

    if (!answer || answer.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Answer is required' });
    }

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Save user answer
    db.saveStage2UserAnswer(pipelineId, answer.trim());
    db.addPipelineLog(pipelineId, 'stage2_answer', 'Stage 2 answer submitted');
    
    // Get updated pipeline with communication log
    const updatedPipeline = db.getPipeline(pipelineId);
    
    // Get chip definitions
    const allChips = db.getChips();
    
    // Build follow-up prompt
    const aiPrompt = prompts.buildStage2FollowupPrompt(
      updatedPipeline.stage1,
      updatedPipeline.stage2.communication_log,
      answer.trim(),
      allChips
    );
    
    console.log('[Stage2Answer] Calling AI for pipeline:', pipelineId);

    // Call AI
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt);
    
    const { status, questions, master_prompt } = aiResponse.parsed;
    
    // Update Stage 2
    db.saveStage2AiResponse(pipelineId, status, questions || [], master_prompt);
    
    // Add AI response to communication log
    const db2 = db.getDb();
    const currentLog = updatedPipeline.stage2.communication_log || [];
    currentLog.push({
      role: 'assistant',
      content: status === 'confirmed' 
        ? 'Understanding confirmed. Master Prompt created.'
        : questions.join('\n'),
      timestamp: Date.now()
    });
    db2.prepare(`
      UPDATE stage2_understanding SET communication_log = ? WHERE pipeline_id = ?
    `).run(JSON.stringify(currentLog), pipelineId);
    
    const finalPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      status: aiResponse.parsed.status,
      ai_questions: aiResponse.parsed.questions || [],
      master_prompt: aiResponse.parsed.master_prompt || null,
      usage: aiResponse.usage,
      pipeline: finalPipeline
    });
    
  } catch (error) {
    console.error('[Stage2Answer] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

/**
 * Process Gate 02 (confirm understanding, move to Stage 3 with research)
 * POST /api/pipeline/:id/gate2
 */
router.post('/:id/gate2', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 2) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 2' });
    }
    
    if (pipeline.locked_gates.includes(2)) {
      return res.status(400).json({ success: false, error: 'Gate 02 is already locked' });
    }
    
    // Check that Stage 2 is confirmed
    if (pipeline.stage2.status !== 'confirmed' || !pipeline.stage2.master_prompt) {
      return res.status(400).json({ 
        success: false, 
        error: 'Stage 2 must be confirmed with a Master Prompt before proceeding' 
      });
    }
    
    const { gateway_url, gateway_token, local_ai_url } = req.body;

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Mark Stage 2 as complete
    db.completeStage2(pipelineId, pipeline.stage2.master_prompt);
    
    // Get chip definitions
    const allChips = db.getChips();
    
    // Build Stage 3 prompt
    const aiPrompt = prompts.buildStage3Prompt(
      pipeline.stage2.master_prompt,
      pipeline.stage1,
      allChips
    );
    
    console.log('[Gate02] Calling AI for research directives:', pipelineId);

    // Call AI
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt);
    
    const { research_question, research_areas, initial_observations } = aiResponse.parsed;
    
    // Save Stage 3 AI response
    db.saveStage3AiResponse(pipelineId, research_question, research_areas, initial_observations);
    
    // Lock Gate 02 and advance to Stage 3
    const newLockedGates = [...pipeline.locked_gates, 2];
    db.updatePipeline(pipelineId, {
      current_stage: 3,
      locked_gates: newLockedGates
    });
    
    db.addPipelineLog(pipelineId, 'gate2', 'Gate 02 processed — Stage 3 activated');
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      stage: 3,
      research_question,
      research_areas,
      initial_observations,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Gate02] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

// ═══════════════════════════════════════
// STAGE 3: Research & Gate 03
// ═══════════════════════════════════════

/**
 * Submit user research input
 * POST /api/pipeline/:id/stage3/answer
 */
router.post('/:id/stage3/answer', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 3) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 3' });
    }
    
    const { answer, gateway_url, gateway_token, local_ai_url } = req.body;

    // Answer can be empty (user has no additional context)
    const userAnswer = answer?.trim() || 'No additional context provided.';

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Save user answer
    db.saveStage3UserAnswer(pipelineId, userAnswer);
    db.addPipelineLog(pipelineId, 'stage3_answer', 'Stage 3 research input submitted');
    
    // Get chip definitions
    const allChips = db.getChips();
    
    // Build synthesis prompt
    const aiPrompt = prompts.buildStage3SynthesisPrompt(
      pipeline.stage2.master_prompt,
      pipeline.stage1,
      pipeline.stage3.research_areas || [],
      userAnswer,
      allChips
    );
    
    console.log('[Stage3Answer] Calling AI for research synthesis:', pipelineId);

    // Call AI (with fallback in case AI returns plain markdown)
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt, [], 'research_master_guide');
    
    const { research_master_guide } = aiResponse.parsed;
    
    // Complete Stage 3
    db.completeStage3(pipelineId, research_master_guide);
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      status: 'complete',
      research_master_guide,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Stage3Answer] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

/**
 * Process Gate 03 (move to Stage 4 with implementation plan)
 * POST /api/pipeline/:id/gate3
 */
router.post('/:id/gate3', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 3) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 3' });
    }
    
    if (pipeline.locked_gates.includes(3)) {
      return res.status(400).json({ success: false, error: 'Gate 03 is already locked' });
    }
    
    // Check that Stage 3 is complete
    if (pipeline.stage3.status !== 'complete' || !pipeline.stage3.research_master_guide) {
      return res.status(400).json({ 
        success: false, 
        error: 'Stage 3 must be complete with Research Master Guide before proceeding' 
      });
    }
    
    const { gateway_url, gateway_token, local_ai_url } = req.body;

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Get chip definitions
    const allChips = db.getChips();

    // Build Stage 4 prompt
    const aiPrompt = prompts.buildStage4Prompt(
      pipeline.stage2.master_prompt,
      pipeline.stage3.research_master_guide,
      pipeline.stage1,
      allChips
    );
    
    console.log('[Gate03] Calling AI for implementation plan:', pipelineId);

    // Call AI
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt);
    
    const { implementation_notes, verification_checklist, ready_to_deploy, question } = aiResponse.parsed;
    
    // Save Stage 4 plan
    db.saveStage4Plan(pipelineId, implementation_notes, verification_checklist, ready_to_deploy, question);
    
    // Lock Gate 03 and advance to Stage 4
    const newLockedGates = [...pipeline.locked_gates, 3];
    db.updatePipeline(pipelineId, {
      current_stage: 4,
      locked_gates: newLockedGates
    });
    
    db.addPipelineLog(pipelineId, 'gate3', 'Gate 03 processed — Stage 4 activated');
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      stage: 4,
      implementation_notes,
      verification_checklist,
      ready_to_deploy,
      question,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Gate03] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

// ═══════════════════════════════════════
// STAGE 4: Implementation & Gate 04 (Deploy)
// ═══════════════════════════════════════

/**
 * Submit user implementation feedback
 * POST /api/pipeline/:id/stage4/answer
 */
router.post('/:id/stage4/answer', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 4) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 4' });
    }
    
    const { answer, gateway_url, gateway_token, local_ai_url } = req.body;

    if (!answer || answer.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Feedback is required' });
    }

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Save user feedback
    db.saveStage4UserFeedback(pipelineId, answer.trim());
    db.addPipelineLog(pipelineId, 'stage4_feedback', 'Stage 4 feedback submitted');
    
    // Get chip definitions
    const allChips = db.getChips();
    
    // Rebuild the implementation plan with user feedback
    const revisedPrompt = `${prompts.buildStage4Prompt(
      pipeline.stage2.master_prompt,
      pipeline.stage3.research_master_guide,
      pipeline.stage1,
      allChips
    )}

## User Feedback on Previous Plan
${answer.trim()}

Please revise your implementation plan based on this feedback.`;
    
    console.log('[Stage4Answer] Calling AI for revised plan:', pipelineId);

    // Call AI
    const aiResponse = await sendAiRequest(req, pipeline, revisedPrompt);
    
    const { implementation_notes, verification_checklist, ready_to_deploy, question } = aiResponse.parsed;
    
    // Update Stage 4 plan
    db.saveStage4Plan(pipelineId, implementation_notes, verification_checklist, ready_to_deploy, question);
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      implementation_notes,
      verification_checklist,
      ready_to_deploy,
      question,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Stage4Answer] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

/**
 * Process Gate 04 (Deploy - execute implementation)
 * POST /api/pipeline/:id/gate4
 */
router.post('/:id/gate4', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 4) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 4' });
    }
    
    if (pipeline.locked_gates.includes(4)) {
      return res.status(400).json({ success: false, error: 'Gate 04 is already locked' });
    }
    
    const { gateway_url, gateway_token, local_ai_url } = req.body;

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Mark as deploying
    db.markStage4Deploying(pipelineId);
    
    // Get chip definitions
    const allChips = db.getChips();
    
    // Build deployment prompt
    const aiPrompt = prompts.buildStage4DeployPrompt(
      pipeline.stage2.master_prompt,
      pipeline.stage3.research_master_guide,
      pipeline.stage4.implementation_notes,
      pipeline.stage1,
      allChips
    );
    
    console.log('[Gate04] Calling AI for deployment:', pipelineId);

    // Call AI (this is the big one)
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt);
    
    const { output_short, output_detailed, implementation_notes } = aiResponse.parsed;
    
    // Save output to Stage 5
    db.saveStage5Output(pipelineId, output_short, output_detailed, implementation_notes);
    
    // Complete Stage 4
    db.completeStage4(pipelineId, pipeline.stage4.implementation_notes);
    
    // Lock Gate 04 and advance to Stage 5
    const newLockedGates = [...pipeline.locked_gates, 4];
    db.updatePipeline(pipelineId, {
      current_stage: 5,
      locked_gates: newLockedGates
    });
    
    db.addPipelineLog(pipelineId, 'gate4', 'Deploy processed — Stage 5 activated');
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      stage: 5,
      output_short,
      output_detailed,
      implementation_notes,
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[Gate04] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

// ═══════════════════════════════════════
// STAGE 5: Output & PAE
// ═══════════════════════════════════════

/**
 * Generate PAE (Post AI Evaluation)
 * POST /api/pipeline/:id/pae
 */
router.post('/:id/pae', async (req, res) => {
  const pipelineId = req.params.id;
  
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ success: false, error: 'Pipeline not found' });
    }
    
    if (pipeline.current_stage !== 5) {
      return res.status(400).json({ success: false, error: 'Pipeline is not at Stage 5' });
    }
    
    if (!pipeline.stage5.output_detailed) {
      return res.status(400).json({ success: false, error: 'No output to evaluate' });
    }
    
    const { gateway_url, gateway_token, local_ai_url } = req.body;

    if (!local_ai_url && (!gateway_url || !gateway_token)) {
      return res.status(400).json({ success: false, error: 'AI credentials required — configure OpenClaw or Local AI' });
    }

    // Get chip definitions
    const allChips = db.getChips();

    // Build PAE prompt
    const aiPrompt = prompts.buildPAEPrompt(
      pipeline.stage2.master_prompt,
      pipeline.stage1,
      pipeline.stage5.output_short,
      pipeline.stage5.output_detailed,
      allChips
    );
    
    console.log('[PAE] Calling AI for evaluation:', pipelineId);

    // Call AI
    const aiResponse = await sendAiRequest(req, pipeline, aiPrompt);
    
    const { accuracy, completeness, confidence, comments } = aiResponse.parsed;
    
    // Save PAE scores
    db.savePAE(pipelineId, accuracy, completeness, confidence, comments);
    db.addPipelineLog(pipelineId, 'pae', 'PAE generated');
    
    const updatedPipeline = db.getPipeline(pipelineId);
    
    res.json({
      success: true,
      pae: {
        accuracy,
        completeness,
        confidence,
        comments
      },
      usage: aiResponse.usage,
      pipeline: updatedPipeline
    });
    
  } catch (error) {
    console.error('[PAE] Error:', error);
    const { code, hint } = getErrorDetails(error);
    res.status(500).json({ success: false, error: code, _code: code, _hint: hint });
  }
});

export default router;

