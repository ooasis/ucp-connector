/**
 * RFC 9421 HTTP Message Signatures for UCP (WebCrypto port of the
 * conformance-proven Magento Lib/Rfc9421.php).
 *
 * UCP profile per spec/docs/specification/signatures.md:
 *   - ES256 (baseline, MUST verify) / ES384 / EdDSA (Ed25519)
 *   - ECDSA signatures in fixed-width raw r||s (P1363) — WebCrypto native
 *   - JWK keys (EC + OKP); alg/use optional; unsupported keys skipped, not fatal
 *   - Content-Digest per RFC 9530 (sha-256 over raw body bytes)
 *
 * ponytail: default-UCP signatures only — no RFC 9421 §2.1.2 dictionary-member
 * component selection (;key=), so WBA-shape signatures are not verifiable yet.
 */

import { createHash, type webcrypto } from 'node:crypto';
import { SignatureError } from './errors.js';

export type Jwk = Record<string, any>;

/** Curve params: per-integer signature width and WebCrypto hash. */
const EC_CURVES: Record<string, { width: number; hash: string }> = {
  'P-256': { width: 32, hash: 'SHA-256' },
  'P-384': { width: 48, hash: 'SHA-384' },
};

// -----------------------------------------------------------------------
// Encoding helpers
// -----------------------------------------------------------------------

export function b64urlEncode(bin: Uint8Array): string {
  return Buffer.from(bin).toString('base64url');
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new SignatureError('signature_invalid', 'bad base64url');
  }
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

// -----------------------------------------------------------------------
// JWK handling
// -----------------------------------------------------------------------

/** RFC 7638 thumbprint (lexicographic members crv,kty,x,y) used as kid. */
export function ecJwkThumbprint(jwk: Jwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * True if this verifier can use the key. Per spec, unsupported kty/crv must
 * skip the key, never reject the key set. use:"enc" / key_ops w/o "verify" skipped.
 */
export function keyUsableForVerify(jwk: Jwk): boolean {
  if ((jwk.use ?? 'sig') === 'enc') return false;
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return false;
  switch (jwk.kty) {
    case 'EC':
      return jwk.crv in EC_CURVES && jwk.x != null && jwk.y != null;
    case 'OKP':
      return jwk.crv === 'Ed25519' && jwk.x != null;
    default:
      return false;
  }
}

async function importVerifyKey(jwk: Jwk): Promise<webcrypto.CryptoKey> {
  const pub: Jwk =
    jwk.kty === 'OKP'
      ? { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
      : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
  const alg = jwk.kty === 'OKP' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: jwk.crv };
  try {
    return await crypto.subtle.importKey('jwk', pub, alg, false, ['verify']);
  } catch (e) {
    throw new SignatureError('algorithm_unsupported', String(e));
  }
}

// -----------------------------------------------------------------------
// RFC 9530 Content-Digest
// -----------------------------------------------------------------------

/** RFC 9530 Content-Digest header value (sha-256 over raw body bytes). */
export function contentDigest(body: string | Uint8Array): string {
  return 'sha-256=:' + createHash('sha256').update(body).digest('base64') + ':';
}

// -----------------------------------------------------------------------
// Signature base (RFC 9421 §2.5)
// -----------------------------------------------------------------------

export type SignatureContext = {
  method?: string;
  authority?: string;
  path?: string;
  query?: string;
  status?: number;
};

/**
 * Build the signature base. `components` is the ordered covered-component list,
 * `ctx` supplies derived values, `headers` is a lowercase-name map, `params` is
 * the raw serialized signature params (signed verbatim).
 */
export function signatureBase(
  components: string[],
  ctx: SignatureContext,
  headers: Record<string, string>,
  params: string,
): string {
  const lines: string[] = [];
  for (const c of components) {
    let value: string;
    switch (c) {
      case '@method':
        value = String(ctx.method).toUpperCase();
        break;
      case '@authority':
        value = String(ctx.authority).toLowerCase();
        break;
      case '@path':
        value = String(ctx.path);
        break;
      case '@query':
        value = '?' + (ctx.query ?? '');
        break;
      case '@status':
        value = String(ctx.status);
        break;
      default:
        if (c.startsWith('@')) {
          throw new SignatureError('signature_invalid', `unsupported derived component ${c}`);
        }
        if (headers[c] === undefined) {
          throw new SignatureError('signature_invalid', `missing signed header ${c}`);
        }
        value = headers[c].trim();
    }
    lines.push(`"${c}": ${value}`);
  }
  const list = components.map((c) => `"${c}"`).join(' ');
  lines.push(`"@signature-params": (${list})${params}`);
  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Signature-Input parsing (minimal structured-field subset for UCP shapes)
// -----------------------------------------------------------------------

/**
 * Parse 'sig1=("@method" "@path");keyid="k";created=1;tag="x"' into
 * [label, components[], params-string, params-map]. Single signature only.
 * ponytail: no §2.1.2 ;key= component params, no multi-signature — first label wins.
 */
export function parseSignatureInput(
  header: string,
): [string, string[], string, Record<string, string>] {
  const m = header.match(/^\s*([!#$%&'*+\-.^_`|~0-9a-z]+)=\(([^)]*)\)([\s\S]*)$/);
  if (!m) throw new SignatureError('signature_invalid', 'unparseable Signature-Input');
  const [, label, inner, params] = m;
  const components = [...inner.matchAll(/"([^"]+)"/g)].map((c) => c[1]);
  const pmap: Record<string, string> = {};
  for (const p of params.matchAll(/;\s*([a-z]+)=("([^"]*)"|[^;]+)/g)) {
    pmap[p[1]] = p[3] !== undefined ? p[3] : p[2].trim();
  }
  return [label, components, params.replace(/\s+$/, ''), pmap];
}

/** Parse 'sig1=:base64:' -> raw signature bytes. */
export function parseSignatureHeader(header: string, label: string): Uint8Array {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = header.match(new RegExp(escaped + '=:([A-Za-z0-9+/=]+):'));
  if (!m) throw new SignatureError('signature_missing', `no signature for label ${label}`);
  return new Uint8Array(Buffer.from(m[1], 'base64'));
}

// -----------------------------------------------------------------------
// Sign / verify primitives (alg from JWK kty/crv, per spec — never `alg` param)
// -----------------------------------------------------------------------

/** Sign a signature base string with a private JWK (EC P-256/P-384 or Ed25519). */
export async function signBase(base: string, privateJwk: Jwk): Promise<Uint8Array> {
  const data = new TextEncoder().encode(base);
  if (privateJwk.kty === 'OKP') {
    const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, [
      'sign',
    ]);
    return new Uint8Array(await crypto.subtle.sign('Ed25519', key, data));
  }
  const { hash } = EC_CURVES[privateJwk.crv];
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: privateJwk.crv },
    false,
    ['sign'],
  );
  // WebCrypto ECDSA output is already fixed-width r||s (P1363), per spec.
  return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash }, key, data));
}

/** Verify a signature over a base string against a JWK public key. */
export async function verifyBase(base: string, sig: Uint8Array, jwk: Jwk): Promise<boolean> {
  const data = new TextEncoder().encode(base);
  const key = await importVerifyKey(jwk);
  if (jwk.kty === 'OKP') {
    if (sig.length !== 64) return false;
    return crypto.subtle.verify('Ed25519', key, sig, data);
  }
  const { width, hash } = EC_CURVES[jwk.crv];
  if (sig.length !== 2 * width) return false; // enforce fixed-width r||s on the wire
  return crypto.subtle.verify({ name: 'ECDSA', hash }, key, sig, data);
}

// -----------------------------------------------------------------------
// UCP request verification / signing (spec pseudocode, faithfully)
// -----------------------------------------------------------------------

export type RestRequest = {
  method: string;
  authority: string;
  path: string;
  query?: string;
  body?: string | null;
  headers: Record<string, string>;
};

/**
 * VerifyRestRequest per the spec. `keySet` is the signer's published keys[]
 * (already fetched from the profile named in UCP-Agent). Throws SignatureError
 * with a spec reason.
 */
export async function verifyRestRequest(req: RestRequest, keySet: Jwk[]): Promise<void> {
  const headers = req.headers;
  if (!headers['signature-input'] || !headers['signature']) {
    throw new SignatureError('signature_missing');
  }
  const [label, components, params, pmap] = parseSignatureInput(headers['signature-input']);

  // 2. Resolve key: signature-capable keys only, matched by kid.
  let jwk: Jwk | null = null;
  for (const k of keySet) {
    if ((k.kid ?? null) === (pmap.keyid ?? null) && keyUsableForVerify(k)) {
      jwk = k;
      break;
    }
  }
  if (jwk === null) {
    // Distinguish unsupported-alg from absent kid, per the spec's error codes.
    for (const k of keySet) {
      if ((k.kid ?? null) === (pmap.keyid ?? null)) {
        throw new SignatureError('algorithm_unsupported', k.kty ?? '?');
      }
    }
    throw new SignatureError('key_not_found', pmap.keyid ?? '(no keyid)');
  }

  // 2b. Coverage: everything integrity-relevant the request carries must be signed.
  const required = ['@method', '@authority', '@path'];
  if (req.query) required.push('@query');
  if (req.body != null) required.push('content-digest', 'content-type');
  if (headers['idempotency-key'] !== undefined) required.push('idempotency-key');
  if (headers['ucp-agent'] !== undefined) required.push('ucp-agent');
  if (headers['signature-agent'] !== undefined) required.push('signature-agent');
  for (const c of required) {
    if (!components.includes(c)) throw new SignatureError('coverage_insufficient', c);
  }

  // 3. Body digest over raw bytes.
  if (components.includes('content-digest')) {
    if (contentDigest(req.body ?? '') !== (headers['content-digest'] ?? '').trim()) {
      throw new SignatureError('digest_mismatch');
    }
  }

  // 4+5. Rebuild base, verify.
  const base = signatureBase(components, req, headers, params);
  const sig = parseSignatureHeader(headers['signature'], label);
  if (!(await verifyBase(base, sig, jwk))) {
    throw new SignatureError('signature_invalid');
  }
}

/**
 * Sign a REST request. Returns the headers to attach. Used for outbound
 * webhooks and by the smoke script to exercise the verify path.
 */
export async function signRestRequest(
  req: RestRequest,
  privateJwk: Jwk,
  kid: string,
): Promise<Record<string, string>> {
  const headers = { ...req.headers };
  const out: Record<string, string> = {};
  if (req.body != null) {
    headers['content-digest'] = out['Content-Digest'] = contentDigest(req.body);
  }
  const components = ['@method', '@authority', '@path'];
  if (req.query) components.push('@query');
  if (headers['ucp-agent'] !== undefined) components.push('ucp-agent');
  if (headers['idempotency-key'] !== undefined) components.push('idempotency-key');
  if (req.body != null) components.push('content-digest', 'content-type');

  const params = `;keyid="${kid}"`; // default UCP: no created/expires/alg (spec)
  const base = signatureBase(components, req, headers, params);
  const list = components.map((c) => `"${c}"`).join(' ');
  out['Signature-Input'] = `sig1=(${list})${params}`;
  out['Signature'] = 'sig1=:' + Buffer.from(await signBase(base, privateJwk)).toString('base64') + ':';
  return out;
}
