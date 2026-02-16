/**
 * Synthezer Server
 * Local-first prompt pipeline application
 * 
 * Features:
 * - Serves frontend from /frontend/index.html
 * - API endpoints for pipeline management
 * - Proxies AI calls to user's OpenClaw gateway
 * - SQLite database for local persistence
 */

import express from 'express';
import { createServer } from 'http';
import { readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import rateLimit from 'express-rate-limit';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('./package.json');

// Routes
import pipelineRouter from './routes/pipeline.js';
import chipsRouter from './routes/chips.js';
import profileRouter from './routes/profile.js';

// Database
import { initDb, seedChipPacksIfEmpty } from './lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SYNTHEZER_PORT || process.env.CLAWZER_PORT || 8090;
const HOST = process.env.SYNTHEZER_HOST || process.env.CLAWZER_HOST || '0.0.0.0'; // Bind to all interfaces for Tailscale access
const execAsync = promisify(exec);

const AI_TIMEOUT_MS = 7_200_000;       // 2 hours — AI requests can take long for complex outputs
const DEBUG_LOG = '/tmp/synthezer-proxy.log';
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(DEBUG_LOG, line + '\n'); } catch {}
}
const JSON_BODY_LIMIT = '10mb';
const DETECT_TIMEOUT_MS = 3_000;       // Local AI provider detection
const TAILSCALE_TEST_TIMEOUT_MS = 10_000;

// Frontend HTML cache — avoids blocking readFileSync on every request
let _cachedFrontendHtml = null;
let _cachedFrontendTime = 0;
const FRONTEND_CACHE_MS = process.env.NODE_ENV === 'production' ? 60000 : 0; // 1 min in prod, no cache in dev

function getFrontendHtml(filePath) {
  const now = Date.now();
  if (!_cachedFrontendHtml || (now - _cachedFrontendTime) > FRONTEND_CACHE_MS) {
    _cachedFrontendHtml = readFileSync(filePath, 'utf-8');
    _cachedFrontendTime = now;
  }
  return _cachedFrontendHtml;
}


// Initialize database
initDb();
seedChipPacksIfEmpty();

// Create Express app
const app = express();

// Middleware
app.disable('x-powered-by'); // Don't leak server technology
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// CORS — restrict to same-origin (localhost) to prevent cross-site data theft
app.use((req, res, next) => {
  const allowedOrigins = [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Url, X-Local-Ai-Url');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Rate limiting — general API limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api', apiLimiter);

// Stricter rate limit for AI proxy endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please slow down' }
});
app.use('/api/oc', aiLimiter);
app.use('/api/local-ai', aiLimiter);

// ═══════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════

// Pipeline management
app.use('/api/pipeline', pipelineRouter);

// Chip management
app.use('/api/chips', chipsRouter);
app.use('/api/profile', profileRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    timestamp: Date.now()
  });
});

/**
 * Read OpenClaw Gateway token from macOS LaunchAgent plist file
 * Returns null if file doesn't exist or token not found
 */
async function readOpenClawToken() {
  try {
    const { default: plist } = await import('plist');
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    const homeDir = os.homedir();
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist');

    const plistContent = await fs.readFile(plistPath, 'utf8');
    const parsed = plist.parse(plistContent);
    return parsed?.EnvironmentVariables?.OPENCLAW_GATEWAY_TOKEN || null;
  } catch {
    return null;
  }
}

/**
 * OpenClaw Gateway token endpoint (legacy)
 * Frontend should use /api/openclaw-detect instead
 */
app.get('/api/openclaw-token', async (req, res) => {
  const token = await readOpenClawToken();
  if (token) {
    res.json({ success: true, token });
  } else {
    res.json({ success: false, error: 'OpenClaw not detected' });
  }
});

/**
 * Check if OpenClaw CLI is available and get version/model info
 * Frontend should use /api/openclaw-detect instead
 */
app.get('/api/openclaw-cli-check', async (req, res) => {
  try {
    // Check CLI availability
    const { stdout } = await execAsync('openclaw --version', { timeout: 5000 });

    // Extract version
    const versionMatch = stdout.match(/OpenClaw (\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';

    // Try to get configured model
    let model = 'claude-opus-4-6'; // default
    try {
      const { stdout: configOut } = await execAsync('openclaw config get agents.defaults.model.primary', {
        timeout: 3000
      });
      if (configOut && configOut.trim()) {
        model = configOut.trim().replace('anthropic/', '');
      }
    } catch {
      // Config read failed, use default
    }

    res.json({ available: true, version, model });
  } catch (error) {
    res.json({ available: false, error: 'OpenClaw CLI not found' });
  }
});

/**
 * Comprehensive OpenClaw Gateway detection
 *
 * Checks three things in order:
 * 1. Is OpenClaw CLI installed? (openclaw --version)
 * 2. Is OpenClaw Gateway running? (port 18789 listening)
 * 3. Can we auto-fill the token? (read from macOS plist)
 *
 * Returns:
 * - detected: true if CLI is installed AND gateway is running
 * - url: Gateway URL if detected (http://localhost:18789)
 * - token: Auto-detected token or empty string if not found
 * - error: Descriptive error message if detection fails
 */
app.get('/api/openclaw-detect', async (req, res) => {
  try {
    // Step 1: Check if CLI is available
    try {
      await execAsync('openclaw --version', { timeout: 3000 });
    } catch {
      return res.json({
        detected: false,
        error: 'OpenClaw CLI not found. Please install OpenClaw from openclaw.ai'
      });
    }

    // Step 2: Check if gateway is running (port 18789)
    try {
      await execAsync('lsof -i :18789 -sTCP:LISTEN', { timeout: 2000 });
    } catch {
      return res.json({
        detected: false,
        error: 'OpenClaw Gateway not running. Please start OpenClaw.'
      });
    }

    // Step 3: Try to auto-fill token from system
    const token = await readOpenClawToken();

    res.json({
      detected: true,
      url: 'http://localhost:18789',
      token: token || '' // Empty string if not found (user can enter manually)
    });

  } catch (error) {
    res.json({
      detected: false,
      error: error.message || 'Detection failed'
    });
  }
});

// ═══════════════════════════════════════
// OPENCLAW PROXY
// ═══════════════════════════════════════

/**
 * Convert HTTP status codes into friendly error hints for the proxy layer.
 * These are returned alongside the raw response so the frontend can show
 * helpful guidance to non-technical users.
 */
function proxyErrorHint(status, url = '') {
  switch (status) {
    case 400: return 'The AI server rejected the request. The Gateway URL or model name may be incorrect.';
    case 401: return 'Authentication failed. Check that your API key/token is correct and not expired.';
    case 403: return 'Access denied. Your API key may not have permission for this model.';
    case 404: return 'Endpoint not found. The Gateway URL appears to be wrong — make sure it points to the AI API, not a website.';
    case 405: return 'The Gateway URL is pointing to a page that doesn\'t accept AI requests. Double-check the URL — it should be the API base URL (not a docs page or login page).';
    case 429: return 'Too many requests. Wait a moment and try again, or check your API quota.';
    case 500: return 'The AI server had an internal error. Try again in a moment.';
    case 502: return 'Could not reach the AI server. It may be offline.';
    case 503: return 'The AI server is temporarily unavailable. Try again in a few minutes.';
    default: return null;
  }
}

/**
 * Validate a URL is safe for proxying.
 * Synthezer is a local-first desktop app — the user controls both client and server,
 * so localhost and private IPs are valid gateway targets.
 * Only block cloud metadata endpoints (169.254.x.x) which are never legitimate gateways.
 */
function isUrlSafeForProxy(urlString) {
  try {
    const parsed = new URL(urlString);
    // Only allow http/https schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    // Block cloud metadata endpoint (link-local) — never a valid AI gateway
    if (host.startsWith('169.254.')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a URL targets only localhost (for local AI providers)
 */
function isUrlLocalOnly(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Normalize a gateway URL to its base form.
 * Users paste all kinds of URLs: full endpoint paths, with/without /v1, etc.
 * This strips any known API path suffixes to get the true base URL.
 */
function normalizeGatewayBase(url) {
  return url
    .replace(/\/v1(?:\/.*)?$/, '')   // strip /v1 and anything after it
    .replace(/\/+$/, '');            // strip trailing slashes
}

/**
 * Fetch with manual redirect handling that preserves the HTTP method.
 *
 * Standard fetch converts POST → GET on 301/302 redirects (per HTTP spec),
 * which breaks API calls to gateways that redirect HTTP → HTTPS.
 * This function follows redirects while keeping POST as POST.
 *
 * Security:
 *  - Validates every redirect URL with the provided validator (prevents SSRF via open redirect)
 *  - Strips Authorization header on cross-origin redirects (prevents token leakage)
 *  - Limits total redirects to prevent infinite loops
 */
async function safeFetch(url, options, urlValidator, maxRedirects = 5) {
  let currentUrl = url;
  let currentOptions = options;

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      ...currentOptions,
      redirect: 'manual',
    });

    // Not a redirect — return the response
    if (response.status < 300 || response.status >= 400) {
      if (i > 0) debugLog(`[safeFetch] Final response: ${response.status} from ${currentUrl}`);
      return response;
    }

    // Get redirect location
    const location = response.headers.get('location');
    debugLog(`[safeFetch] ${response.status} redirect → ${location || '(no location header)'}`);
    if (!location) return response;

    // Resolve relative redirect URLs
    let redirectUrl;
    try {
      redirectUrl = new URL(location, currentUrl).href;
    } catch {
      return response; // Invalid redirect URL — return as-is
    }

    // Security: validate redirect target
    if (urlValidator && !urlValidator(redirectUrl)) {
      return response; // Unsafe target — don't follow
    }

    // Security: strip Authorization header on cross-origin redirects
    try {
      const origOrigin = new URL(currentUrl).origin;
      const newOrigin = new URL(redirectUrl).origin;
      if (origOrigin !== newOrigin && currentOptions.headers) {
        const safeHeaders = { ...currentOptions.headers };
        delete safeHeaders['Authorization'];
        delete safeHeaders['authorization'];
        currentOptions = { ...currentOptions, headers: safeHeaders };
      }
    } catch { /* ignore origin parse errors */ }

    currentUrl = redirectUrl;
  }

  throw new Error('Too many redirects — check that the Gateway URL is correct');
}

// ═══════════════════════════════════════
// LOCAL AI PROXY
// ═══════════════════════════════════════

/**
 * Auto-detect local AI providers by scanning known ports
 */
app.get('/api/local-ai/detect', async (req, res) => {
  const knownProviders = [
    { name: 'Ollama', port: 11434 },
    { name: 'LM Studio', port: 1234 },
    { name: 'Jan', port: 1337 },
    { name: 'GPT4All', port: 4891 },
    { name: 'text-generation-webui', port: 5000 },
    { name: 'vLLM', port: 8000 },
    { name: 'llama.cpp / LocalAI', port: 8080 },
  ];

  const results = await Promise.all(knownProviders.map(async (p) => {
    const url = `http://127.0.0.1:${p.port}`;
    try {
      const modelsRes = await fetch(`${url}/v1/models`, {
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      });
      if (!modelsRes.ok) {
        return { name: p.name, port: p.port, url, status: 'error', models: [] };
      }
      const data = await modelsRes.json();
      // Ollama returns { models: [...] }, OpenAI-compat returns { data: [...] }
      let models = [];
      if (Array.isArray(data.data)) {
        models = data.data.map(m => m.id || m.name || 'unknown');
      } else if (Array.isArray(data.models)) {
        models = data.models.map(m => m.name || m.model || 'unknown');
      }
      return { name: p.name, port: p.port, url, status: 'online', models };
    } catch {
      return { name: p.name, port: p.port, url, status: 'offline', models: [] };
    }
  }));

  res.json({ success: true, providers: results });
});

/**
 * Proxy requests to local AI provider
 * The local URL is provided in the X-Local-Ai-Url header
 */
app.use('/api/local-ai', async (req, res, next) => {
  // Skip the detect endpoint — it's handled by the app.get above
  if (req.path === '/detect') return next();

  const localUrl = req.headers['x-local-ai-url'];

  if (!localUrl) {
    return res.status(400).json({ error: 'Missing X-Local-Ai-Url header' });
  }

  if (!isUrlLocalOnly(localUrl)) {
    return res.status(400).json({ error: 'Only localhost URLs are allowed for local AI' });
  }

  // Build target URL — extract path after /api/local-ai
  const targetPath = req.originalUrl.replace('/api/local-ai', '') || '/';
  // Normalize path to prevent traversal
  const normalizedPath = new URL(targetPath, 'http://localhost').pathname;
  const fullUrl = localUrl.replace(/\/$/, '') + normalizedPath;

  try {
    const headers = { 'Content-Type': 'application/json' };
    // Forward optional auth (some providers like text-gen-webui support API keys)
    if (req.headers['authorization']) {
      headers['Authorization'] = req.headers['authorization'];
    }

    const response = await safeFetch(fullUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD'
        ? JSON.stringify(req.body)
        : undefined,
      signal: AbortSignal.timeout(AI_TIMEOUT_MS), // 2 hour timeout
    }, isUrlLocalOnly);

    const data = await response.text();

    // For error responses, add a user-friendly hint
    if (!response.ok) {
      const hint = proxyErrorHint(response.status, localUrl);
      const code = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(data);
        parsed._code = code;
        if (hint) parsed._hint = hint;
        res.status(response.status).json(parsed);
      } catch {
        res.status(response.status).json({
          error: code,
          _code: code,
          _hint: hint || `The local AI server returned ${code}. Check that the provider is running.`
        });
      }
      return;
    }

    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.send(data);

  } catch (error) {
    console.error('[LocalAI Proxy] Error:', error.message);
    let code, hint;
    if (error.message.includes('Too many redirects')) {
      code = 'Too many redirects';
      hint = 'The local AI URL keeps redirecting. Make sure the host and port are correct.';
    } else if (error.message.includes('ECONNREFUSED')) {
      code = 'Connection refused';
      hint = 'Cannot connect to the local AI server. Make sure it is running (e.g. start Ollama, LM Studio, etc.).';
    } else if (error.message.includes('timed out') || error.message.includes('abort')) {
      code = 'Timed out';
      hint = 'The local AI server took too long to respond. The model may still be loading — wait a moment and try again.';
    } else {
      code = 'Connection failed';
      hint = 'Cannot reach the local AI server. Check that it is running and the URL is correct.';
    }
    res.status(502).json({ error: code, _code: code, _hint: hint });
  }
});

/**
 * Proxy requests to user's AI gateway
 *
 * This endpoint acts as a CORS-friendly proxy between the frontend and the user's AI provider.
 * The gateway URL is provided in the X-Gateway-Url header.
 *
 * Special handling for OpenClaw Gateway:
 * - OpenClaw uses WebSocket protocol, not REST API
 * - Instead of proxying HTTP, we use the `openclaw` CLI via lib/openclaw-adapter.js
 * - Detection: URLs containing :18789 or :19001 (OpenClaw default ports)
 * - CLI returns OpenAI-compatible JSON response for seamless integration
 *
 * For local AI providers (Ollama, LM Studio, vLLM, etc.):
 * - Standard HTTP proxy with redirect handling
 * - Adds user-friendly error hints for common failures
 */
app.use('/api/oc', async (req, res) => {
  const gatewayUrl = req.headers['x-gateway-url'];

  if (!gatewayUrl) {
    return res.status(400).json({ error: 'Missing X-Gateway-Url header' });
  }

  // Validate the gateway URL to prevent SSRF attacks
  if (!isUrlSafeForProxy(gatewayUrl)) {
    return res.status(400).json({ error: 'Invalid gateway URL' });
  }

  // Check if this is OpenClaw Gateway (port 18789 or 19001)
  const isOpenClawGateway = gatewayUrl.includes(':18789') || gatewayUrl.includes(':19001');

  // Handle OpenClaw Gateway via CLI adapter
  if (isOpenClawGateway && req.originalUrl.includes('/v1/chat/completions') && req.method === 'POST') {
    console.log('[Proxy] OpenClaw Gateway detected, routing to CLI adapter');

    try {
      const { callOpenClawCLI } = await import('./lib/openclaw-adapter.js');

      // Extract prompt from OpenAI-compatible message format
      const messages = req.body.messages || [];
      const lastMessage = messages[messages.length - 1];
      const prompt = typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : lastMessage?.content?.find(c => c.type === 'text')?.text || '';

      if (!prompt) {
        return res.status(400).json({ error: 'No prompt provided' });
      }

      // Call OpenClaw CLI (returns OpenAI-compatible response)
      const response = await callOpenClawCLI(prompt, req.body.model || 'openclaw:main', {
        temperature: req.body.temperature,
        max_tokens: req.body.max_tokens,
        timeout: AI_TIMEOUT_MS
      });

      return res.json(response);

    } catch (error) {
      console.error('[Proxy] OpenClaw CLI error:', error.message);
      return res.status(500).json({
        error: error.message,
        _code: 'OpenClaw Error',
        _hint: 'OpenClaw CLI failed. Make sure OpenClaw is installed and running.'
      });
    }
  }

  // Build target URL - extract path after /api/oc
  const targetPath = req.originalUrl.replace('/api/oc', '') || '/';
  // Normalize path to prevent traversal
  const normalizedPath = new URL(targetPath, 'http://localhost').pathname;
  // Normalize: strip /v1/... and trailing slashes to prevent double-path issues
  const baseUrl = normalizeGatewayBase(gatewayUrl);
  const fullUrl = baseUrl + normalizedPath;

  debugLog(`[Proxy] ${req.method} → ${fullUrl}  (raw gateway: ${gatewayUrl})`);

  try {
    const response = await safeFetch(fullUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || '',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD'
        ? JSON.stringify(req.body)
        : undefined,
      signal: AbortSignal.timeout(AI_TIMEOUT_MS), // 2 hour timeout for large deployments
    }, isUrlSafeForProxy);

    const data = await response.text();

    debugLog(`[Proxy] Response: ${response.status} body: ${data.substring(0, 200)}`);

    // For error responses, add a user-friendly hint
    if (!response.ok) {
      console.log(`[Proxy] Error ${response.status} from ${fullUrl}:`, data.substring(0, 300));
      const hint = proxyErrorHint(response.status, fullUrl);
      const code = `HTTP ${response.status}`;
      try {
        // Try to merge hint into JSON response
        const parsed = JSON.parse(data);
        parsed._code = code;
        if (hint) parsed._hint = hint;
        res.status(response.status).json(parsed);
      } catch {
        // Non-JSON response — wrap it
        res.status(response.status).json({
          error: code,
          _code: code,
          _hint: hint || `The AI server returned ${code}. Check your Gateway URL and API key.`
        });
      }
      return;
    }

    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.send(data);

  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    let code, hint;
    if (error.message.includes('Too many redirects')) {
      code = 'Too many redirects';
      hint = 'The Gateway URL keeps redirecting. Make sure you entered the correct API URL (not a website or login page).';
    } else if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
      code = 'Connection failed';
      hint = 'Cannot connect to the AI server. Make sure it is running and the Gateway URL is correct.';
    } else if (error.message.includes('ENOTFOUND')) {
      code = 'Server not found';
      hint = 'The Gateway URL hostname was not found. Double-check the URL in your AI settings.';
    } else if (error.message.includes('timed out') || error.message.includes('abort')) {
      code = 'Timed out';
      hint = 'The AI server took too long to respond. Try again or switch to a faster model.';
    } else {
      code = 'Connection failed';
      hint = 'Could not reach the AI server. Check that the Gateway URL is correct and the server is running.';
    }
    res.status(502).json({ error: code, _code: code, _hint: hint });
  }
});

// ═══════════════════════════════════════
// TAILSCALE CONNECTION HELPERS
// ═══════════════════════════════════════

/**
 * Test if a Tailscale device is reachable
 * Uses direct HTTP connection to verify connectivity
 */
app.get('/api/tailscale/test', async (req, res) => {
  const { device } = req.query;
  const port = parseInt(req.query.port || 3456);
  if (!port || port < 1 || port > 65535) return res.status(400).json({ success: false, error: 'Invalid port number' });
  
  if (!device) {
    return res.status(400).json({ error: 'Device parameter required' });
  }

  // Validate device is a Tailscale IP (100.x.x.x) or safe hostname
  const tailscaleIpPattern = /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const safeHostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!tailscaleIpPattern.test(device) && !safeHostnamePattern.test(device)) {
    return res.status(400).json({ success: false, error: 'Invalid device identifier' });
  }

  try {
    const startTime = Date.now();
    
    // Try to resolve the device (could be IP or hostname)
    let targetHost = device;
    
    // If it's not an IP address, try to get it from tailscale status
    if (!device.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      try {
        const { stdout } = await execAsync('tailscale status --json');
        const status = JSON.parse(stdout);
        
        // Find device by name
        const peer = Object.values(status.Peer).find(p => 
          p.HostName === device || p.DNSName === `${device}.` || p.DNSName === `${device}.tailscale.net.`
        );
        
        if (peer) {
          targetHost = peer.TailscaleIPs[0];
        }
      } catch (e) {
        // Tailscale CLI not available or error, try device name directly
        console.log('[Tailscale] CLI not available, using device name directly:', device);
      }
    }
    
    // Try to connect to the OpenClaw port
    const testUrl = `http://${targetHost}:${port}/v1/models`;
    
    try {
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(TAILSCALE_TEST_TIMEOUT_MS)
      });
      
      const latency = Date.now() - startTime;
      
      if (response.ok) {
        return res.json({
          reachable: true,
          ip: targetHost,
          device: device,
          port: port,
          latency: latency
        });
      } else {
        return res.json({
          reachable: false,
          error: `HTTP ${response.status}`,
          ip: targetHost
        });
      }
    } catch (e) {
      console.error('[Tailscale Test] Connection failed:', e.message);
      console.error('[Tailscale Test] Tried URL:', testUrl);
      
      let errorMsg = e.message;
      let suggestion = '';
      let installTailscale = false;
      
      // Provide helpful error messages
      if (e.message.includes('fetch failed') || e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED') || e.message.includes('getaddrinfo') || e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
        errorMsg = 'Cannot reach Tailscale device';
        suggestion = 'This computer cannot reach the Tailscale network. Install Tailscale on this computer and login with the same account.';
        installTailscale = true;
      }
      
      return res.json({
        reachable: false,
        error: errorMsg,
        suggestion: suggestion,
        installTailscale: installTailscale,
        ip: targetHost
      });
    }
    
  } catch (error) {
    console.error('[Tailscale] Unexpected error:', error.message);
    res.status(500).json({
      reachable: false,
      error: 'Connection test failed',
      suggestion: 'An unexpected error occurred. Check the server logs for details.'
    });
  }
});

// ═══════════════════════════════════════
// FRONTEND SERVING
// ═══════════════════════════════════════

// Security headers for frontend
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
].join('; ');

// Serve frontend (fresh read every request for development)
app.get('/', (req, res) => {
  try {
    const html = getFrontendHtml(join(__dirname, 'frontend', 'index.html'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.send(html);
  } catch (error) {
    res.status(500).send('Error loading frontend');
  }
});

// Catch-all for SPA routing - use middleware for Express 5 compatibility
app.use((req, res, next) => {
  // Skip if API route (should already be handled)
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  // Serve frontend for all other routes
  try {
    const html = getFrontendHtml(join(__dirname, 'frontend', 'index.html'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.send(html);
  } catch (error) {
    res.status(500).send('Error loading frontend');
  }
});

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════

const server = createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Another Synthezer instance may be running, or another app is using this port.`);
    console.error(`  Fix: kill the other process, or set SYNTHEZER_PORT to a different port.\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           Synthezer Pipeline v3.0                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Local:      http://localhost:${PORT}              ║`);
  console.log(`║  Network:    http://0.0.0.0:${PORT}                ║`);
  console.log(`║  API:        http://localhost:${PORT}/api          ║`);
  console.log('║  Database:   ./db/synthezer.db                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
});


