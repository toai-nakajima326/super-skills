/**
 * scripts/lib/otel.js — OTEL SDK initialization for AIOS (Pillar 3).
 *
 * Exports:
 *   initOtel()            — boot the SDK (idempotent). Safe to call when
 *                           Langfuse is down or env vars are missing:
 *                           returns false instead of throwing.
 *   getTracer(name)       — returns an OTEL Tracer, or a noop stub that
 *                           matches the public API shape (startActiveSpan,
 *                           startSpan). Callers never branch on "is the
 *                           SDK up?" — they just call startActiveSpan and
 *                           the noop does nothing.
 *   shutdownOtel()        — drain pending spans on process exit.
 *
 * Contract: observability is a bonus channel, never a dependency. Every
 * failure mode in this file degrades to noop rather than raising.
 *
 * Env vars:
 *   LANGFUSE_HOST         — e.g. http://localhost:9091 (if unset -> noop)
 *   LANGFUSE_PUBLIC_KEY   — pk-lf-...
 *   LANGFUSE_SECRET_KEY   — sk-lf-...
 *   OTEL_SERVICE_NAME     — default "vcontext"
 *   OTEL_DEPLOY_ENV       — default "local"
 */

// ── Noop fallback (returned when SDK not ready) ───────────────────────
// Shape mirrors @opentelemetry/api.Tracer so call-sites stay identical.
const NOOP_SPAN = {
  setAttribute() {},
  setAttributes() {},
  setStatus() {},
  recordException() {},
  addEvent() {},
  end() {},
  spanContext() { return { traceId: '', spanId: '', traceFlags: 0 }; },
  isRecording() { return false; },
  updateName() {},
};
const NOOP_TRACER = {
  startSpan() { return NOOP_SPAN; },
  startActiveSpan(_name, arg2, arg3, arg4) {
    // Signature: (name, [options], [context], fn)
    const fn = typeof arg4 === 'function' ? arg4
             : typeof arg3 === 'function' ? arg3
             : typeof arg2 === 'function' ? arg2
             : null;
    if (!fn) return undefined;
    try { return fn(NOOP_SPAN); } catch (e) { throw e; }
  },
};

let _sdk = null;
let _ready = false;
let _initAttempted = false;
let _api = null; // lazily-imported @opentelemetry/api

/**
 * Initialize the OTEL SDK. Safe to call more than once — subsequent calls
 * are no-ops. Returns true if SDK is running, false if we degraded to noop.
 */
export async function initOtel() {
  if (_initAttempted) return _ready;
  _initAttempted = true;

  const host = (process.env.LANGFUSE_HOST || '').trim();
  if (!host) {
    // No Langfuse configured — silent noop. This is the expected state
    // until the user runs `docker compose up` and sets keys.
    return false;
  }

  const pubKey = process.env.LANGFUSE_PUBLIC_KEY || '';
  const secKey = process.env.LANGFUSE_SECRET_KEY || '';
  if (!pubKey || !secKey) {
    console.warn('[otel] LANGFUSE_HOST set but keys missing — tracing disabled');
    return false;
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, resourcesMod, apiMod] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/api'),
    ]);
    _api = apiMod;

    const serviceName = process.env.OTEL_SERVICE_NAME || 'vcontext';
    const deployEnv = process.env.OTEL_DEPLOY_ENV || 'local';

    // Langfuse OTLP endpoint: POST /api/public/otel/v1/traces
    // Auth: HTTP Basic (public:secret) base64-encoded
    const endpoint = host.replace(/\/+$/, '') + '/api/public/otel/v1/traces';
    const authHeader = 'Basic ' + Buffer.from(`${pubKey}:${secKey}`).toString('base64');

    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: { Authorization: authHeader },
      // Short timeout — we never want tracing to block a request
      timeoutMillis: 3000,
    });

    // Build resource via whichever API the installed package version exposes.
    const resAttrs = {
      'service.name': serviceName,
      'deployment.environment': deployEnv,
      'service.version': process.env.npm_package_version || 'dev',
    };
    let resource;
    if (typeof resourcesMod.resourceFromAttributes === 'function') {
      resource = resourcesMod.resourceFromAttributes(resAttrs);
    } else if (resourcesMod.Resource) {
      // Older API surface
      resource = new resourcesMod.Resource(resAttrs);
    }

    _sdk = new NodeSDK({
      resource,
      traceExporter: exporter,
      // No auto-instrumentations for now — we instrument by hand so we
      // control exactly which spans hit Langfuse. Adding HTTP auto-instr
      // here would 10x the ingest volume without giving us GenAI attrs.
      instrumentations: [],
    });

    _sdk.start();
    _ready = true;
    console.log(`[otel] tracing enabled -> ${endpoint} (service=${serviceName})`);

    // Best-effort graceful shutdown
    const shutdown = () => shutdownOtel().catch(() => {});
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return true;
  } catch (e) {
    console.warn('[otel] init failed, falling back to noop:', (e && e.message) || e);
    _ready = false;
    return false;
  }
}

/**
 * Return a Tracer for the given instrumentation name. When the SDK isn't
 * running, returns a noop that satisfies the Tracer shape so callers
 * never have to check.
 */
export function getTracer(name = 'aios') {
  if (!_ready || !_api) return NOOP_TRACER;
  try {
    return _api.trace.getTracer(name);
  } catch {
    return NOOP_TRACER;
  }
}

/**
 * Convenience: run `fn(span)` inside a new active span, closing the span
 * on return / throw. Sets status=ERROR on throw and re-raises.
 */
export async function withSpan(tracerName, spanName, attrs, fn) {
  const tracer = getTracer(tracerName);
  return await new Promise((resolve, reject) => {
    tracer.startActiveSpan(spanName, { attributes: attrs || {} }, async (span) => {
      try {
        const result = await fn(span);
        try { span.setStatus({ code: 1 }); } catch {} // OK
        resolve(result);
      } catch (e) {
        try {
          span.recordException(e);
          span.setStatus({ code: 2, message: (e && e.message) || String(e) });
        } catch {}
        reject(e);
      } finally {
        try { span.end(); } catch {}
      }
    });
  });
}

/** Drain exporter queue on shutdown. */
export async function shutdownOtel() {
  if (!_sdk) return;
  try { await _sdk.shutdown(); } catch {}
  _sdk = null;
  _ready = false;
}

/** Lightweight probe for dashboard / diagnostics. */
export function otelStatus() {
  return {
    enabled: _ready,
    host: process.env.LANGFUSE_HOST || null,
    service: process.env.OTEL_SERVICE_NAME || 'vcontext',
  };
}
