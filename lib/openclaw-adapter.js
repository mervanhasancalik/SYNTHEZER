/**
 * OpenClaw CLI Adapter
 *
 * Provides an OpenAI-compatible interface to OpenClaw Gateway via the `openclaw` CLI.
 *
 * Why CLI instead of WebSocket?
 * - OpenClaw Gateway uses a complex WebSocket protocol with cryptographic device signatures
 * - The CLI handles all authentication and session management automatically
 * - More maintainable and compatible with future OpenClaw updates
 * - Requires `openclaw` CLI to be installed globally
 *
 * @see https://openclaw.ai for OpenClaw installation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Call OpenClaw agent via CLI
 *
 * Executes the `openclaw agent` command and returns an OpenAI-compatible response.
 * Each pipeline/session gets its own OpenClaw session for conversation continuity.
 *
 * @param {string} prompt - The prompt to send to the agent
 * @param {string} model - Model identifier (informational only, OpenClaw uses configured model)
 * @param {object} options - Additional options
 * @param {string} [options.sessionId='synthezer-main'] - OpenClaw session ID for conversation continuity
 * @param {number} [options.timeout=120000] - Timeout in milliseconds
 * @param {number} [options.temperature] - Temperature (passed through but OpenClaw may ignore)
 * @param {number} [options.max_tokens] - Max tokens (passed through but OpenClaw may ignore)
 * @returns {Promise<object>} - OpenAI-compatible chat completion response
 * @throws {Error} If OpenClaw CLI is not installed or command fails
 */
export async function callOpenClawCLI(prompt, model = 'openclaw:main', options = {}) {
  const sessionId = options.sessionId || 'synthezer-main';
  const timeout = Math.floor((options.timeout || 120000) / 1000); // Convert to seconds

  // Validate sessionId to prevent injection (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: must contain only alphanumeric characters, hyphens, and underscores`);
  }

  // Build openclaw agent arguments as an array (no shell escaping needed with execFile)
  const args = [
    'agent',
    '--json',
    '--session-id', sessionId,
    '--timeout', String(timeout),
    '--message', prompt
  ];

  console.log('[OpenClaw] Executing: openclaw', args.slice(0, 4).join(' ') + '...');

  try {
    const { stdout, stderr } = await execFileAsync('openclaw', args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large responses
      timeout: (timeout + 5) * 1000 // Add 5s buffer
    });

    if (stderr && !stderr.includes('🦞')) {
      console.warn('[OpenClaw] Warning:', stderr);
    }

    const result = JSON.parse(stdout);

    if (result.status !== 'ok') {
      throw new Error(`OpenClaw agent failed: ${result.summary || 'Unknown error'}`);
    }

    // Extract the agent's response text
    const text = result.result?.payloads?.[0]?.text || '';
    const usage = result.result?.meta?.agentMeta?.usage || {};

    // Convert to OpenAI-compatible format
    return {
      id: result.runId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.result?.meta?.agentMeta?.model || model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: usage.input || 0,
        completion_tokens: usage.output || 0,
        total_tokens: usage.total || 0
      }
    };
  } catch (error) {
    // Parse error for better messages
    if (error.code === 'ETIMEDOUT') {
      throw new Error('OpenClaw agent timed out - the request took too long');
    }

    if (error.stderr) {
      throw new Error(`OpenClaw error: ${error.stderr}`);
    }

    throw error;
  }
}
