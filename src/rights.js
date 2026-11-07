import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const hashImage = bytes => createHash('sha256').update(bytes).digest('hex');
export function publicHttps(value) {
  try {
    const u = new URL(value);
    // Do not fetch arbitrary registered URLs: only approved allowlisted hosts in network adapters.
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hostname.includes(':') &&
      !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname) && !u.hostname.endsWith('.local');
  } catch { return false; }
}
export function validateImage(i, sns, now = new Date(), { ai = false, site = false, download = false } = {}) {
  if (!i || !i.id || !i.productId || !i.source || !i.evidence || !i.approvedBy || !i.approvedAt ||
      !Number.isFinite(Date.parse(i.approvedAt)) || Date.parse(i.approvedAt) > +now || !/^[a-f0-9]{64}$/.test(i.hash ?? '') || !i.storagePath) throw new Error('rights_unconfirmed');
  if (!Number.isFinite(Date.parse(i.expiresAt)) || Date.parse(i.expiresAt) <= +now) throw new Error('rights_expired');
  if (!i.permissions || (sns && i.permissions[sns] !== true) || (ai && i.permissions.ai !== true) ||
      (site && i.permissions.site !== true) || (download && i.permissions.download !== true)) throw new Error('rights_missing_scope');
  if (sns || site) {
    if (i.permissions.publicHosting !== true || !publicHttps(i.publicUrl)) throw new Error('hosting_not_permitted');
    if (!Number.isFinite(Date.parse(i.publicUrlExpiresAt)) || Date.parse(i.publicUrlExpiresAt) <= +now) throw new Error('image_url_expired');
  }
  if (sns === 'instagram' && i.mime !== 'image/jpeg') throw new Error('instagram_requires_jpeg');
  return i;
}
export function requirePair(images, sns, now, options = {}) {
  const pair = [];
  for (const i of images) {
    try { validateImage(i, sns, now, options); }
    catch { continue; }
    if (!pair.some(p => p.hash === i.hash || p.publicUrl === i.publicUrl)) pair.push(i);
    if (pair.length === 2) return pair;
  }
  throw new Error('two_licensed_images_required');
}
export function registerRights(store, image, now) {
  validateImage(image, null, now);
  if (!existsSync(image.storagePath) || hashImage(readFileSync(image.storagePath)) !== image.hash) throw new Error('image_hash_mismatch');
  if (!store.product(image.productId)) throw new Error('unknown_product');
  store.saveImage(image);
}
export function putLicensedImage(bytes, image, directory, limits, now) {
  validateImage(image, null, now, { download: true });
  if (hashImage(bytes) !== image.hash) throw new Error('image_hash_mismatch');
  mkdirSync(directory, { recursive: true });
  const files = readdirSync(directory).filter(f => /^[a-f0-9]{64}$/.test(f));
  const target = join(directory, image.hash);
  if (existsSync(target)) return target;
  if (files.length >= limits.maxFiles || files.reduce((n,f) => n+statSync(join(directory,f)).size,0)+bytes.length > limits.maxBytes) throw new Error('storage_limit');
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return target;
}
