// A stand-in phone for the P2-227 tests: P-256 passkeys and session keys made with crypto.generateKeyPairSync.
// authenticatorData = sha256(rpId) || flags || 4-byte counter; passkey signatures are DER, session-key signatures IEEE P1363.
import crypto from 'node:crypto';
import { b64u, canonical, challengeFor, sha256 } from '../../bin/remote-lib.mjs';

export const RP = 'localhost', ORIGIN = 'http://localhost:4567';

export function makePasskey(label = 'iPhone') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = b64u(crypto.randomBytes(16));
  const spki = b64u(publicKey.export({ format: 'der', type: 'spki' }));
  return { id, spki, privateKey, label, counter: 0 };
}

// One assertion over `obj`. Options change one thing at a time for the refusal tests.
export function assert(pk, obj, { rpId = RP, origin = ORIGIN, flags = 0x05, counter = pk.counter, type = 'webauthn.get', challenge, signWith } = {}) {
  const ad = Buffer.concat([sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), Buffer.alloc(4)]);
  ad.writeUInt32BE(counter, 33);
  const cd = Buffer.from(JSON.stringify({ type, challenge: challenge ?? challengeFor(obj), origin, crossOrigin: false }), 'utf8');
  const sig = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), signWith || pk.privateKey);
  return { cred: pk.id, authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u(sig) };
}

export const command = (kind, args = {}, issued_at = Date.now()) => ({ v: 1, id: b64u(crypto.randomBytes(16)), kind, args, issued_at });
export const viaPasskey = (pk, cmd, opts) => ({ command: cmd, auth: { via: 'passkey', ...assert(pk, cmd, opts) } });

export function makeGrant(pk, { issued_at = Date.now(), life = 600000, scopes = ['decide'], opts } = {}) {
  const s = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const grant = { v: 1, type: 'grant', id: b64u(crypto.randomBytes(16)), key: b64u(s.publicKey.export({ format: 'der', type: 'spki' })), scopes, issued_at, expires_at: issued_at + life };
  return { grant, grant_auth: assert(pk, grant, opts), session: s.privateKey };
}
export function viaGrant(g, cmd) {
  const signature = b64u(crypto.sign('sha256', Buffer.from(canonical(cmd), 'utf8'), { key: g.session, dsaEncoding: 'ieee-p1363' }));
  return { command: cmd, auth: { via: 'grant', grant: g.grant, grant_auth: g.grant_auth, signature } };
}
export const trusted = (...pks) => ({ keys: pks.map(p => ({ id: p.id, spki: p.spki, label: p.label, added_at: Date.now(), sign_count: 0 })), rejected: [] });
