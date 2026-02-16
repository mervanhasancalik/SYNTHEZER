/**
 * Synthezer AI Module
 * Handles communication with AI providers
 *
 * Architecture:
 * - The user configures their AI connection in the frontend UI
 * - This module receives gateway URL + token from the caller
 * - Routes to appropriate adapter based on provider type
 *
 * Supported Providers:
 * 1. OpenClaw Gateway - WebSocket-based agent platform
 *    - Auto-detected by port (18789 or 19001)
 *    - Uses CLI adapter (lib/openclaw-adapter.js) instead of direct WebSocket
 *
 * 2. Local AI providers - Standard HTTP chat completion endpoints
 *    - Ollama (localhost:11434)
 *    - LM Studio (localhost:1234)
 *    - vLLM, llama.cpp, LocalAI, Jan, GPT4All
 *    - Any local provider implementing /v1/chat/completions
 *
 * @module lib/ai
 */

import { callOpenClawCLI } from './openclaw-adapter.js';

const AI_TIMEOUT_MS = 7_200_000; // 2 hours for large deployments

/**
 * Detect if a URL points to OpenClaw Gateway
 * OpenClaw Gateway runs on ports 18789 (default) or 19001 (alternate)
 * @param {string} url - The gateway URL to check
 * @returns {boolean} True if URL contains OpenClaw Gateway port
 */
function isOpenClawGateway(url) {
  return url.includes(':18789') || url.includes(':19001');
}

/**
 * Throw a user-friendly error for an HTTP status code.
 * The thrown Error has:
 *   .message  — short code string like "HTTP 405"
 *   .hint     — plain-language explanation of what happened and how to fix it
 */
function throwApiError(status, body, provider = 'AI') {
  const detail = (body || '').substring(0, 150).trim();
  let hint;

  switch (status) {
    case 400:
      hint = detail.toLowerCase().includes('model')
        ? 'The model name is not recognized. Open the AI settings and pick a valid model from the list.'
        : 'The gateway did not accept this request. Double-check your Gateway URL in the AI settings.';
      break;
    case 401:
      hint = 'Authentication failed — your API key or token was rejected. Open the AI settings and make sure the token is correct and has not expired.';
      break;
    case 403:
      hint = 'Access denied — your API key does not have permission for this model or endpoint. Check your AI provider account for usage limits or restrictions.';
      break;
    case 404:
      hint = 'Endpoint not found — the Gateway URL appears to be wrong. Make sure it points to your AI provider\'s API base URL.';
      break;
    case 405:
      hint = 'The Gateway URL is pointing to a page that doesn\'t accept AI requests. This usually means the URL is incorrect — make sure you entered the base API URL, not a docs page or dashboard link.';
      break;
    case 408:
      hint = 'The AI server took too long to respond. Try again, or switch to a faster model.';
      break;
    case 413:
      hint = 'The request is too large. Your prompt or attached images may exceed the model\'s limit. Try shortening your input or removing images.';
      break;
    case 422:
      hint = 'Invalid request parameters — the model name or settings may be wrong. Try selecting a different model in the AI settings.';
      break;
    case 429:
      hint = 'Rate limited — you\'re sending requests too quickly, or your API quota is used up. Wait a minute and try again, or check your provider\'s usage/billing page.';
      break;
    case 500:
      hint = 'The AI server had an internal error. This is not your fault — try again in a moment.';
      break;
    case 502:
      hint = 'Bad gateway — could not reach the AI server. Check that the server is running and your Gateway URL is correct.';
      break;
    case 503:
      hint = 'The AI server is temporarily unavailable (maintenance or overloaded). Wait a few minutes and try again.';
      break;
    case 504:
      hint = 'The AI server took too long to respond. The model may be overloaded. Try again later or switch to a faster model.';
      break;
    default:
      hint = detail || 'Check your AI settings and try again.';
  }

  const err = new Error(`HTTP ${status}`);
  err.hint = `${provider}: ${hint}`;
  err.statusCode = status;
  throw err;
}

/**
 * Build message content for OpenAI-compatible APIs
 * Handles both text-only and multimodal (text + images) content
 *
 * @param {string} text - The text prompt
 * @param {Array} images - Optional array of {name, type, data} image objects
 *                         data should be base64 data URI (e.g., "data:image/png;base64,...")
 * @returns {string|Array} - Simple string for text-only, or content array for multimodal
 */
function buildMessageContent(text, images = []) {
  if (!images || images.length === 0) {
    return text;
  }

  // Build multimodal content array (OpenAI format)
  const content = [
    { type: 'text', text }
  ];

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: {
        url: img.data // Base64 data URI
      }
    });
  }

  return content;
}

/**
 * Call AI provider (OpenClaw or OpenAI-compatible REST API)
 *
 * This is the main entry point for AI calls in Synthezer.
 * Auto-detects provider type and routes to appropriate adapter.
 *
 * For OpenClaw Gateway (ports 18789/19001):
 * - Routes to CLI adapter (lib/openclaw-adapter.js)
 * - Token not used (CLI handles authentication)
 * - Images not yet supported
 *
 * For local AI providers (Ollama, LM Studio, vLLM, etc.):
 * - Standard REST API call to /v1/chat/completions
 * - Token sent as Bearer authorization
 * - Images supported via multimodal content
 *
 * @param {string} gatewayUrl - AI provider's gateway URL
 * @param {string} gatewayToken - API token/key for authentication
 * @param {string} prompt - The prompt to send
 * @param {string} model - Model identifier (e.g., 'openclaw:main', 'llama3')
 * @param {object} options - Additional options
 * @param {number} [options.temperature] - Sampling temperature (0-1)
 * @param {number} [options.max_tokens] - Maximum tokens to generate
 * @param {Array} [options.images] - Array of {name, type, data} image objects for vision models
 * @returns {Promise<object>} - OpenAI-compatible chat completion response
 * @throws {Error} If gateway URL/token missing or API call fails
 */
export async function callOpenClaw(gatewayUrl, gatewayToken, prompt, model = 'openclaw:main', options = {}) {
  if (!gatewayUrl || !gatewayToken) {
    throw new Error('Gateway URL and token are required');
  }

  const { images, ...restOptions } = options;

  // Route to CLI adapter for OpenClaw Gateway
  if (isOpenClawGateway(gatewayUrl)) {
    console.log('[AI] Detected OpenClaw Gateway, routing to CLI adapter');

    if (images && images.length > 0) {
      console.warn('[AI] Warning: Image support not yet implemented for OpenClaw Gateway');
    }

    return await callOpenClawCLI(prompt, model, {
      ...restOptions,
      timeout: AI_TIMEOUT_MS
    });
  }

  // Otherwise use standard REST API
  const baseUrl = gatewayUrl.replace(/\/v1(?:\/.*)?$/, '').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/chat/completions`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: buildMessageContent(prompt, images)
      }
    ],
    ...restOptions
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throwApiError(response.status, errorText, 'OpenClaw');
  }

  const data = await response.json();
  return data;
}

/**
 * Call a local AI provider (OpenAI-compatible endpoint)
 *
 * @param {string} localUrl - Local AI base URL (e.g., http://127.0.0.1:11434)
 * @param {string} prompt - The prompt to send
 * @param {string} model - Model identifier
 * @param {object} options - Additional options (temperature, max_tokens, images, etc.)
 * @returns {Promise<object>} - AI response
 */
export async function callLocalAI(localUrl, prompt, model = 'default', options = {}) {
  if (!localUrl) {
    throw new Error('Local AI URL is required');
  }

  const { images, ...restOptions } = options;
  // Normalize: strip /v1 and anything after it, plus trailing slashes
  const baseUrl = localUrl.replace(/\/v1(?:\/.*)?$/, '').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/chat/completions`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: buildMessageContent(prompt, images)
      }
    ],
    ...restOptions
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS) // 2 hour timeout
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throwApiError(response.status, errorText, 'Local AI');
  }

  const data = await response.json();
  return data;
}

/**
 * Send a structured prompt to local AI and get parsed JSON response
 * @param {string} localUrl
 * @param {string} prompt
 * @param {string} model
 * @param {Array} images - Optional array of images
 * @param {string} fallbackKey - If AI returns non-JSON, wrap in object with this key
 */
export async function sendStructuredPromptLocal(localUrl, prompt, model = 'default', images = [], fallbackKey = null) {
  const response = await callLocalAI(localUrl, prompt, model, {
    temperature: 0.3,
    images
  });

  const content = extractContent(response);
  const parsed = parseJsonResponse(content, fallbackKey);

  return {
    raw: content,
    parsed,
    usage: response.usage
  };
}

/**
 * Extract the assistant's message content from OpenClaw response
 */
export function extractContent(response) {
  return response?.choices?.[0]?.message?.content || '';
}

/**
 * Parse JSON from AI response, handling markdown code blocks
 */
export function parseJsonResponse(content, fallbackKey = null) {
  // Clean up common issues
  let cleaned = content.trim();
  
  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try extracting from markdown code block
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (e2) {
        // Fall through
      }
    }
    
    // Try finding JSON object in text
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (e3) {
        // Fall through
      }
    }
    
    // If we have a fallback key, wrap the content as that key's value
    // This handles cases where AI returns plain text instead of JSON
    if (fallbackKey) {
      console.log('[AI] Wrapping non-JSON response as', fallbackKey);
      return { [fallbackKey]: cleaned };
    }
    
    throw new Error('Failed to parse AI response as JSON');
  }
}

/**
 * Send a structured prompt and get parsed JSON response
 * @param {string} gatewayUrl
 * @param {string} gatewayToken
 * @param {string} prompt
 * @param {string} model
 * @param {Array} images - Optional array of images
 * @param {string} fallbackKey - If AI returns non-JSON, wrap in object with this key
 */
export async function sendStructuredPrompt(gatewayUrl, gatewayToken, prompt, model = 'openclaw:main', images = [], fallbackKey = null) {
  const response = await callOpenClaw(gatewayUrl, gatewayToken, prompt, model, {
    temperature: 0.3, // Lower temperature for more consistent structured output
    images
  });
  
  const content = extractContent(response);
  const parsed = parseJsonResponse(content, fallbackKey);
  
  return {
    raw: content,
    parsed,
    usage: response.usage
  };
}

export default {
  callOpenClaw,
  callLocalAI,
  extractContent,
  parseJsonResponse,
  sendStructuredPrompt,
  sendStructuredPromptLocal
};

