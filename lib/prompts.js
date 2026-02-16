/**
 * Synthezer AI Prompt Templates
 * Structured prompts for each pipeline stage
 */

// ═══════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════

function normalizeChip(item) {
  if (typeof item === 'string') return { name: item };
  if (item && typeof item === 'object') {
    return { name: item.name || String(item), priority: item.priority };
  }
  return { name: String(item) };
}

function resolveChips(names, category, chipDefinitions) {
  if (!names || names.length === 0) return 'None specified';
  
  return names.map(item => {
    const chipInfo = normalizeChip(item);
    const chipName = (chipInfo.name || '').toUpperCase();
    const chip = chipDefinitions.find(c => c.category === category && c.name === chipName);
    const label = chipInfo.priority === 'high' ? `${chipName} (PRIMARY)` : chipName;
    return chip?.description 
      ? `• ${label}: ${chip.description}`
      : `• ${label}`;
  }).join('\n');
}

function resolveChipsCompact(names, category, chipDefinitions) {
  if (!names || names.length === 0) return 'None';
  return names.map(item => {
    const chipInfo = normalizeChip(item);
    const chipName = (chipInfo.name || '').toUpperCase();
    const chip = chipDefinitions.find(c => c.category === category && c.name === chipName);
    const label = chipInfo.priority === 'high' ? `${chipName} (PRIMARY)` : chipName;
    return chip?.description ? `${label}: ${chip.description}` : label;
  }).join(', ');
}

// ═══════════════════════════════════════
// STAGE 2: UNDERSTANDING
// ═══════════════════════════════════════

/**
 * Build prompt for Stage 1 → Stage 2 transition
 * AI should understand the request and ask clarifying questions if needed
 */
export function buildStage2Prompt(stage1Data, chipDefinitions = []) {
  const imageNote = stage1Data.images?.length > 0 
    ? `\n\n**ATTACHED IMAGES:** ${stage1Data.images.length} image(s) attached. Analyze them carefully as part of the request.`
    : '';
    
  return `You are the Understanding Agent in a Synthezer pipeline. Your task is to deeply understand the user's request and ask clarifying questions if ANYTHING is unclear, ambiguous, or could be interpreted multiple ways.

## User's Request (Stage 1 Input)

**PROMPT:**
${stage1Data.prompt || 'No prompt provided'}${imageNote}

**AI MIND (Behavioral approach):**
${resolveChips(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}

**PRE-REQUISITES (Do these first):**
${resolveChips(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}

**IMPLEMENTATION AREA:**
${resolveChips(stage1Data.implementation_area, 'implementation', chipDefinitions)}

**TOOLS AVAILABLE:**
${resolveChips(stage1Data.tools, 'tools', chipDefinitions)}

**NO-GO RULES (Never do these):**
${resolveChips(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Your Task

1. Read the request completely and carefully
2. Identify any unclear, ambiguous, or underspecified aspects
3. If ANYTHING needs clarification → ask specific, targeted questions (max 5)
4. If everything is perfectly clear → create a Master Prompt

## Response Format

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.

If you have questions:
{
  "status": "questioning",
  "questions": [
    "Your specific question 1?",
    "Your specific question 2?"
  ],
  "preliminary_understanding": "Brief summary of what you understand so far, and what aspects need clarification."
}

If everything is clear (no questions needed):
{
  "status": "confirmed",
  "questions": [],
  "master_prompt": "A comprehensive, enhanced version of the user's request that is:\n- Self-contained (any AI can follow it without additional context)\n- Precise (no ambiguity)\n- Complete (includes all constraints, tools, and behavioral guidelines)\n- Actionable (clear steps or outcome)"
}

Remember: It's better to ask questions now than to make wrong assumptions later. Be thorough.`;
}

/**
 * Build prompt for Stage 2 follow-up (after user answers questions)
 */
export function buildStage2FollowupPrompt(stage1Data, communicationLog, userAnswer, chipDefinitions = []) {
  const historyStr = communicationLog.map(entry => {
    return entry.role === 'assistant' 
      ? `AI: ${entry.content}`
      : `USER: ${entry.content}`;
  }).join('\n\n');

  return `You are the Understanding Agent in a Synthezer pipeline, continuing a conversation to understand the user's request.

## Original Request (Stage 1)

**PROMPT:** ${stage1Data.prompt || 'No prompt provided'}

**AI MIND:** ${resolveChipsCompact(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}
**PRE-REQUISITES:** ${resolveChipsCompact(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}
**IMPLEMENTATION AREA:** ${resolveChipsCompact(stage1Data.implementation_area, 'implementation', chipDefinitions)}
**TOOLS:** ${resolveChipsCompact(stage1Data.tools, 'tools', chipDefinitions)}
**NO-GO RULES:** ${resolveChipsCompact(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Previous Communication
${historyStr || 'None'}

## User's Latest Answer
${userAnswer}

## Your Task

Based on the user's answer:
1. If you now have complete understanding → create the Master Prompt
2. If you still have questions → ask them (but avoid repeating previous questions)

## Response Format (JSON only)

{
  "status": "confirmed" or "questioning",
  "questions": [] or ["question1?", "question2?"],
  "master_prompt": "Full master prompt if status is confirmed, otherwise null"
}`;
}

// ═══════════════════════════════════════
// STAGE 3: RESEARCH
// ═══════════════════════════════════════

/**
 * Build prompt for Stage 2 → Stage 3 transition
 * AI analyzes the master prompt and creates research directives
 */
export function buildStage3Prompt(masterPrompt, stage1Data, chipDefinitions = []) {
  return `You are the Research Agent in a Synthezer pipeline. Your task is to analyze the Master Prompt and determine what research, context, or domain knowledge is needed before implementation.

## Master Prompt (from Stage 2)
${masterPrompt}

## Context from Stage 1
- **AI Mind:** ${resolveChipsCompact(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}
- **Pre-Requisites:** ${resolveChipsCompact(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}
- **Implementation Area:** ${resolveChipsCompact(stage1Data.implementation_area, 'implementation', chipDefinitions)}
- **Tools:** ${resolveChipsCompact(stage1Data.tools, 'tools', chipDefinitions)}
- **No-Go Rules:** ${resolveChipsCompact(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Your Task

1. Analyze what information/research is needed to implement this correctly
2. Ask the user if they have any relevant context, links, or domain knowledge
3. Identify what you'll need to research or figure out

## Response Format (JSON only)

{
  "research_question": "A focused question asking the user what context/links/domain knowledge they can provide. Be specific about what would help.",
  "research_areas": [
    "Area 1 that needs to be researched",
    "Area 2 that needs investigation",
    "..."
  ],
  "initial_observations": "Brief notes on what you already know that's relevant"
}`;
}

/**
 * Build prompt for Stage 3 research synthesis (after user provides input)
 */
export function buildStage3SynthesisPrompt(masterPrompt, stage1Data, researchAreas, userResearchInput, chipDefinitions = []) {
  return `You are the Research Agent in a Synthezer pipeline. The user has provided additional context/research. Now create the Research Master Guide.

## Master Prompt
${masterPrompt}

## Context
- **AI Mind:** ${resolveChipsCompact(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}
- **Pre-Requisites:** ${resolveChipsCompact(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}
- **Implementation Area:** ${resolveChipsCompact(stage1Data.implementation_area, 'implementation', chipDefinitions)}
- **Tools:** ${resolveChipsCompact(stage1Data.tools, 'tools', chipDefinitions)}
- **No-Go Rules:** ${resolveChipsCompact(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Research Areas Identified
${researchAreas.map((a, i) => `${i + 1}. ${a}`).join('\n') || 'None specified'}

## User's Research Input
${userResearchInput || 'No additional input provided'}

## Your Task

Create a comprehensive Research Master Guide that will be used during implementation.

CRITICAL: You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no code blocks. Just the raw JSON.

{
  "research_master_guide": "Your detailed guide here as a single string. Use \\n for line breaks."
}

Example of valid response:
{"research_master_guide": "## Technical Approach\\nUse React with TypeScript...\\n\\n## Best Practices\\n1. Component structure..."}`;
}

// ═══════════════════════════════════════
// STAGE 4: IMPLEMENTATION
// ═══════════════════════════════════════

/**
 * Build prompt for Stage 3 → Stage 4 transition
 * AI creates implementation plan with verification checklist
 */
export function buildStage4Prompt(masterPrompt, researchMasterGuide, stage1Data, chipDefinitions = []) {
  return `You are the Implementation Agent in a Synthezer pipeline. Your task is to create a detailed implementation plan based on the Master Prompt and Research Guide.

## Master Prompt
${masterPrompt}

## Research Master Guide
${researchMasterGuide}

## Constraints
- **AI Mind:** ${resolveChipsCompact(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}
- **Pre-Requisites:** ${resolveChipsCompact(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}
- **Implementation Area:** ${resolveChipsCompact(stage1Data.implementation_area, 'implementation', chipDefinitions)}
- **Tools:** ${resolveChipsCompact(stage1Data.tools, 'tools', chipDefinitions)}
- **No-Go Rules:** ${resolveChipsCompact(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Your Task

Create an implementation plan that can be executed. Include:
1. Implementation notes (what will be built, key decisions)
2. A verification checklist mapping requirements to the plan
3. Any questions or clarifications needed from the user before proceeding

## Response Format (JSON only)

{
  "implementation_notes": "Detailed notes on how you'll implement this, key technical decisions, architecture choices, etc.",
  "verification_checklist": {
    "requirements": "How each requirement from the Master Prompt is addressed",
    "no_go": "How No-Go rules are being respected",
    "research": "How research findings are being applied",
    "prerequisites": "How prerequisites are satisfied",
    "ai_mind": "How AI Mind directives are followed"
  },
  "ready_to_deploy": true or false,
  "question": "If not ready, what do you need from the user? Otherwise null"
}`;
}

/**
 * Build prompt for Stage 4 deployment (actual implementation)
 * This is what gets sent to sub-agents or executed
 */
export function buildStage4DeployPrompt(masterPrompt, researchMasterGuide, implementationPlan, stage1Data, chipDefinitions = []) {
  return `You are executing an implementation task in a Synthezer pipeline. Follow the plan precisely and deliver the complete output.

## Master Prompt (What to Build)
${masterPrompt}

## Research Guide (Technical Context)
${researchMasterGuide}

## Implementation Plan (How to Build)
${implementationPlan}

## Behavioral Guidelines
${resolveChips(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}

## Pre-Requisites (Do First)
${resolveChips(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}

## Tools Available
${resolveChips(stage1Data.tools, 'tools', chipDefinitions)}

## NO-GO Rules (Never Do These)
${resolveChips(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Your Task

Execute the implementation plan fully. Deliver the complete output as specified in the Master Prompt.

## Response Format (JSON only)

{
  "output_short": "A brief 2-3 sentence summary of what was created",
  "output_detailed": "The complete, detailed output. This is the main deliverable. Include all code, content, or artifacts requested.",
  "implementation_notes": "Any notes about decisions made during implementation, challenges encountered, or suggestions for improvement"
}`;
}

// ═══════════════════════════════════════
// STAGE 5: PAE (Post AI Evaluation)
// ═══════════════════════════════════════

/**
 * Build prompt for PAE (Post AI Evaluation)
 * AI evaluates its own output against the original requirements
 */
export function buildPAEPrompt(masterPrompt, stage1Data, outputShort, outputDetailed, chipDefinitions = []) {
  return `You are the Evaluation Agent in a Synthezer pipeline. Your task is to critically evaluate the implementation output against the original requirements.

## Original Master Prompt
${masterPrompt}

## Original Constraints
- **AI Mind:** ${resolveChipsCompact(stage1Data.ai_mind, 'ai_mind', chipDefinitions)}
- **Pre-Requisites:** ${resolveChipsCompact(stage1Data.prerequisites, 'prerequisite', chipDefinitions)}
- **Implementation Area:** ${resolveChipsCompact(stage1Data.implementation_area, 'implementation', chipDefinitions)}
- **Tools:** ${resolveChipsCompact(stage1Data.tools, 'tools', chipDefinitions)}
- **No-Go Rules:** ${resolveChipsCompact(stage1Data.no_go_rules, 'no_go', chipDefinitions)}

## Implementation Output

**Summary:**
${outputShort}

**Detailed Output:**
${outputDetailed}

## Your Task

Provide an honest, critical self-evaluation. Score each metric 0-100:
- **Accuracy:** Does the output correctly implement what was requested?
- **Completeness:** Are all requirements addressed? Is anything missing?
- **Confidence:** How confident are you in the quality of this output?

Be brutally honest. If something is incomplete or wrong, say so.

## Response Format (JSON only)

{
  "accuracy": 0-100,
  "completeness": 0-100,
  "confidence": 0-100,
  "comments": "Detailed evaluation notes. What was done well? What could be improved? Any concerns or caveats?"
}`;
}

export default {
  buildStage2Prompt,
  buildStage2FollowupPrompt,
  buildStage3Prompt,
  buildStage3SynthesisPrompt,
  buildStage4Prompt,
  buildStage4DeployPrompt,
  buildPAEPrompt,
};

