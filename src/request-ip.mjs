import { isIP } from 'node:net';

export function normalizeAddress(value) {
  let address = String(value || '').trim();
  if (address.startsWith('[') && address.includes(']')) {
    address = address.slice(1, address.indexOf(']'));
  }
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address;
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  return address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('127.');
}

export function clientAddress(req, trustProxy = false) {
  const direct = normalizeAddress(req?.socket?.remoteAddress);
  if (!trustProxy || !isLoopbackAddress(direct)) return direct;

  const real = normalizeAddress(req?.headers?.['x-real-ip']);
  if (isIP(real)) return real;

  const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
  const last = normalizeAddress(forwarded.split(',').pop());
  return isIP(last) ? last : direct;
}
